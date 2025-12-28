// ==================== BACKEND API POUR UNDEFINED ====================
// Serveur backend séparé pour gérer les appels à l'API Claude de manière sécurisée

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const budgetTracker = require('./budget-tracker');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

if (!CLAUDE_API_KEY) {
    console.error('❌ ERREUR: CLAUDE_API_KEY manquante dans le fichier .env');
    process.exit(1);
}

if (!ADMIN_API_KEY) {
    console.warn('⚠️ AVERTISSEMENT: ADMIN_API_KEY manquante - endpoints admin non sécurisés');
}

if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
    console.warn('⚠️ AVERTISSEMENT: EmailJS non configuré - alertes d\'abus par email désactivées');
}

// Middleware
app.use(cors()); // Autoriser toutes les origines (à restreindre en production)
app.use(express.json());

// Initialize budget tracking
budgetTracker.initializeBudget();

// ==================== TRACKING & RATE LIMITING ====================

// Structure en mémoire pour tracking
// ⚠️ NOTE: Les quotas sont stockés en RAM et seront perdus au redémarrage du serveur
// ✅ C'est acceptable car :
//    - Les quotas se reset naturellement à minuit (nouveau jour = nouveau quota)
//    - Un redémarrage serveur efface les compteurs, ce qui est sécuritaire
//    - Pour production avec haute disponibilité, envisager Redis pour persistance
const userQuotas = new Map(); // { "ip_fingerprint": { date, count, requests: [] } }
const blockedUsers = new Set(); // Set d'IPs/fingerprints bloqués (⚠️ perdus au redémarrage)
const suspiciousActivity = new Map(); // Détection d'abus (⚠️ perdue au redémarrage)

// Fonction pour obtenir la clé unique utilisateur
function getUserKey(ip, fingerprint) {
    return `${ip}_${fingerprint}`;
}

// Fonction pour nettoyer les quotas expirés (appelée toutes les heures)
setInterval(() => {
    const today = new Date().toISOString().split('T')[0];
    for (const [key, data] of userQuotas.entries()) {
        if (data.date !== today) {
            userQuotas.delete(key);
            console.log(`🧹 Quota expiré nettoyé pour: ${key}`);
        }
    }
}, 3600000); // 1 heure

// Middleware pour extraire IP et fingerprint
function extractUserInfo(req, res, next) {
    // Extraire l'IP réelle (gestion proxy/loadbalancer)
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
               req.headers['x-real-ip'] ||
               req.socket.remoteAddress ||
               'unknown';

    // Extraire le fingerprint du body
    const fingerprint = req.body.fingerprint || 'no_fingerprint';

    req.userKey = getUserKey(ip, fingerprint);
    req.userIp = ip;
    req.userFingerprint = fingerprint;

    next();
}

// Middleware de vérification quota
function checkQuota(req, res, next) {
    const userKey = req.userKey;
    const today = new Date().toISOString().split('T')[0];

    // Vérifier si l'utilisateur est bloqué
    if (blockedUsers.has(userKey) || blockedUsers.has(req.userIp)) {
        console.warn(`🚫 Utilisateur bloqué tenté d'accéder: ${userKey}`);
        return res.status(403).json({
            error: 'BLOCKED',
            message: 'Votre accès a été temporairement suspendu. Contactez contact@audentis.fr'
        });
    }

    // Obtenir ou initialiser le quota
    let quotaData = userQuotas.get(userKey);

    if (!quotaData || quotaData.date !== today) {
        // Nouveau jour ou premier accès
        quotaData = {
            date: today,
            count: 0,
            requests: []
        };
        userQuotas.set(userKey, quotaData);
    }

    // Vérifier la limite
    if (quotaData.count >= 10) {
        console.warn(`⚠️ Quota dépassé pour: ${userKey} (${quotaData.count}/10)`);
        return res.status(429).json({
            error: 'QUOTA_EXCEEDED',
            message: 'Limite quotidienne de 10 requêtes atteinte',
            quota: {
                used: quotaData.count,
                limit: 10,
                resetAt: `${today}T23:59:59Z`
            }
        });
    }

    next();
}

// Middleware pour incrémenter le quota après succès
function incrementQuota(req, res, next) {
    const originalJson = res.json.bind(res);

    res.json = function(data) {
        // Incrémenter seulement si succès (pas d'erreur)
        if (!data.error && res.statusCode === 200) {
            const userKey = req.userKey;
            const quotaData = userQuotas.get(userKey);

            if (quotaData) {
                quotaData.count += 1;
                quotaData.requests.push({
                    timestamp: new Date().toISOString(),
                    message: req.body.messages?.[req.body.messages.length - 1]?.content || ''
                });

                console.log(`📊 Quota incrémenté pour ${userKey}: ${quotaData.count}/10`);

                // Détecter abus potentiel
                detectAbuse(userKey, quotaData, req.userIp, req.userFingerprint);
            }
        }

        return originalJson(data);
    };

    next();
}

// Middleware d'authentification pour les endpoints admin
function authenticateAdmin(req, res, next) {
    const apiKey = req.headers['x-admin-api-key'] || req.query.apiKey;

    if (!ADMIN_API_KEY) {
        console.warn('⚠️ ADMIN_API_KEY non configurée, accès admin non sécurisé');
        return next();
    }

    if (!apiKey) {
        return res.status(401).json({
            error: 'Authentification requise',
            message: 'Veuillez fournir une clé API admin via header X-Admin-API-Key ou query param apiKey'
        });
    }

    if (apiKey !== ADMIN_API_KEY) {
        console.warn(`🚫 Tentative d'accès admin avec clé invalide: ${apiKey.substring(0, 10)}...`);
        return res.status(403).json({
            error: 'Accès refusé',
            message: 'Clé API admin invalide'
        });
    }

    next();
}

// Middleware to check monthly budget before Claude API call
function checkMonthlyBudget(req, res, next) {
    if (!budgetTracker.canMakeRequest()) {
        const stats = budgetTracker.getBudgetStats();

        console.error(`🚫 BUDGET LIMITE ATTEINTE: $${stats.totalCost.toFixed(4)} / $${stats.monthlyLimit.toFixed(2)}`);

        return res.status(429).json({
            error: 'BUDGET_EXCEEDED',
            message: 'Budget mensuel API épuisé. Service temporairement indisponible.',
            budget: {
                current: stats.totalCost,
                limit: stats.monthlyLimit,
                resetDate: `${stats.currentMonth}-01T00:00:00Z`
            }
        });
    }

    next();
}

// Fonction de détection d'abus
function detectAbuse(userKey, quotaData, ip, fingerprint) {
    const requests = quotaData.requests;
    const count = quotaData.count;

    let abuseDetected = false;
    let abuseReasons = [];

    // Heuristique 1 : Haute fréquence (10 requêtes en moins de 5 minutes)
    if (count >= 10 && requests.length >= 10) {
        const firstRequest = new Date(requests[0].timestamp);
        const lastRequest = new Date(requests[requests.length - 1].timestamp);
        const durationMinutes = (lastRequest - firstRequest) / 1000 / 60;

        if (durationMinutes < 5) {
            abuseDetected = true;
            abuseReasons.push(`10 requêtes en ${durationMinutes.toFixed(1)} minutes`);
        }
    }

    // Heuristique 2 : Questions identiques répétées
    const messages = requests.map(r => r.message.toLowerCase().trim());
    const uniqueMessages = new Set(messages);
    if (messages.length >= 3 && uniqueMessages.size === 1) {
        abuseDetected = true;
        abuseReasons.push('Questions identiques répétées');
    }

    // Heuristique 3 : Questions très courtes ou spam
    const shortMessages = messages.filter(m => m.length < 5);
    if (shortMessages.length >= 3) {
        abuseDetected = true;
        abuseReasons.push(`${shortMessages.length} questions trop courtes (<5 caractères)`);
    }

    // Heuristique 4 : Caractères aléatoires
    const randomPattern = /^[a-z]{1,3}$|^[^a-z\s]{3,}$/i;
    const randomMessages = messages.filter(m => randomPattern.test(m));
    if (randomMessages.length >= 2) {
        abuseDetected = true;
        abuseReasons.push('Messages aléatoires ou spam détectés');
    }

    if (abuseDetected) {
        console.error(`🚨 ABUS DÉTECTÉ pour ${userKey}:`, abuseReasons.join(', '));

        // Marquer comme suspect
        suspiciousActivity.set(userKey, {
            ip: ip,
            fingerprint: fingerprint,
            reasons: abuseReasons,
            detectedAt: new Date().toISOString(),
            requests: requests
        });

        // Envoyer email d'alerte
        sendAbuseAlert(userKey, ip, fingerprint, abuseReasons, requests);
    }
}

// Fonction pour envoyer email d'alerte abus
async function sendAbuseAlert(userKey, ip, fingerprint, reasons, requests) {
    const alertMessage = `
🚨 ALERTE ABUS DÉTECTÉ - Agent IA Liwe
═══════════════════════════════════════════════════════

👤 UTILISATEUR SUSPECT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Clé utilisateur : ${userKey}
   Adresse IP      : ${ip}
   Fingerprint     : ${fingerprint}
   Date détection  : ${new Date().toLocaleString('fr-FR')}

⚠️ RAISONS DE L'ALERTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${reasons.map(r => `   • ${r}`).join('\n')}

📋 HISTORIQUE DES REQUÊTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${requests.map((r, i) => `   ${i + 1}. [${new Date(r.timestamp).toLocaleTimeString('fr-FR')}] ${r.message.substring(0, 100)}`).join('\n')}

🔧 ACTION RECOMMANDÉE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pour bloquer cet utilisateur, utilisez l'endpoint /admin/block :
curl -X POST http://localhost:3000/admin/block -H "X-Admin-API-Key: YOUR_KEY" -H "Content-Type: application/json" -d '{"userKey":"${userKey}","action":"block"}'

═══════════════════════════════════════════════════════
    `;

    console.error(alertMessage);

    // Envoyer email via EmailJS si configuré
    if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY) {
        try {
            const emailData = {
                to_email: 'contact@audentis.fr',
                site: 'ALERTE ABUS',
                prenom: 'Système',
                nom: 'Sécurité',
                societe: `IP: ${ip}`,
                email: `Fingerprint: ${fingerprint}`,
                telephone: `UserKey: ${userKey}`,
                conversation: alertMessage,
                timestamp: new Date().toLocaleString('fr-FR', {
                    dateStyle: 'full',
                    timeStyle: 'short'
                })
            };

            const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    service_id: EMAILJS_SERVICE_ID,
                    template_id: EMAILJS_TEMPLATE_ID,
                    user_id: EMAILJS_PUBLIC_KEY,
                    accessToken: EMAILJS_PRIVATE_KEY,
                    template_params: emailData
                })
            });

            if (response.ok) {
                console.log('✅ Email d\'alerte abus envoyé avec succès');
            } else {
                console.error('❌ Erreur envoi email alerte abus:', await response.text());
            }
        } catch (error) {
            console.error('❌ Erreur lors de l\'envoi de l\'email d\'alerte:', error);
        }
    } else {
        console.warn('⚠️ EmailJS non configuré - alerte abus non envoyée par email');
    }
}

// Route de test
app.get('/', (req, res) => {
    res.json({
        status: '✅ Backend Undefined is running!',
        message: 'Utilisez POST /api/chat pour envoyer des messages à Claude',
        timestamp: new Date().toISOString()
    });
});

// Route health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});

// Route principale pour le chat (avec rate limiting)
app.post('/api/chat', extractUserInfo, checkQuota, checkMonthlyBudget, incrementQuota, async (req, res) => {
    console.log('📩 Nouvelle requête chat reçue');
    console.log('👤 Utilisateur:', req.userKey, '| IP:', req.userIp);

    try {
        const { messages, system } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                error: 'Format de requête invalide',
                message: 'Le champ "messages" est requis et doit être un tableau'
            });
        }

        console.log('🔄 Envoi à l\'API Claude...');

        // Appeler l'API Claude
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-3-haiku-20240307',
                max_tokens: 1024,
                system: system,
                messages: messages
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Erreur API Claude:', response.status, errorText);

            return res.status(response.status).json({
                error: `Erreur API Claude: ${response.status}`,
                details: errorText
            });
        }

        const data = await response.json();
        console.log('✅ Réponse reçue de Claude');

        // Track budget cost
        if (data.usage && data.usage.input_tokens && data.usage.output_tokens) {
            budgetTracker.trackRequestCost(
                data.usage.input_tokens,
                data.usage.output_tokens,
                req.userKey,
                req.body.messages?.[req.body.messages.length - 1]?.content
            );
        } else {
            console.warn('⚠️ Usage data missing from Claude response - budget not tracked');
        }

        // Retourner la réponse au client
        res.json(data);

    } catch (error) {
        console.error('❌ Erreur serveur:', error);
        res.status(500).json({
            error: 'Erreur serveur',
            message: error.message
        });
    }
});

// Route d'administration pour bloquer/débloquer des utilisateurs
app.post('/admin/block', authenticateAdmin, (req, res) => {
    const { userKey, action } = req.body; // action: 'block' ou 'unblock'

    if (!userKey || !action) {
        return res.status(400).json({ error: 'Paramètres manquants: userKey et action requis' });
    }

    if (action === 'block') {
        blockedUsers.add(userKey);
        console.log(`🚫 Utilisateur bloqué: ${userKey}`);
        res.json({ success: true, message: `Utilisateur ${userKey} bloqué` });
    } else if (action === 'unblock') {
        blockedUsers.delete(userKey);
        console.log(`✅ Utilisateur débloqué: ${userKey}`);
        res.json({ success: true, message: `Utilisateur ${userKey} débloqué` });
    } else {
        res.status(400).json({ error: 'Action invalide (block ou unblock)' });
    }
});

// Route pour consulter les activités suspectes
app.get('/admin/suspicious', authenticateAdmin, (req, res) => {
    const suspicious = Array.from(suspiciousActivity.entries()).map(([key, data]) => ({
        userKey: key,
        ...data
    }));

    res.json({ suspicious });
});

// Route pour consulter le budget mensuel
app.get('/admin/budget', authenticateAdmin, (req, res) => {
    const stats = budgetTracker.getBudgetStats();

    res.json({
        status: 'success',
        budget: stats
    });
});

// Route pour réinitialiser le budget manuellement
app.post('/admin/budget/reset', authenticateAdmin, (req, res) => {
    budgetTracker.manualReset();
    const stats = budgetTracker.getBudgetStats();

    console.log('🔧 Budget reset by admin');

    res.json({
        status: 'success',
        message: 'Budget réinitialisé avec succès',
        budget: stats
    });
});

// Gestion des erreurs 404
app.use((req, res) => {
    res.status(404).json({
        error: 'Route non trouvée',
        path: req.path
    });
});

// Démarrer le serveur
app.listen(PORT, () => {
    console.log('');
    console.log('🚀 ==========================================');
    console.log('🚀  BACKEND UNDEFINED DÉMARRÉ !');
    console.log('🚀 ==========================================');
    console.log(`🌐  Serveur : http://localhost:${PORT}`);
    console.log(`💬  Chat API : http://localhost:${PORT}/api/chat`);
    console.log(`💚  Health : http://localhost:${PORT}/health`);
    console.log('');
    console.log('📝  Connexion :');
    console.log('   ✅ Clé API Claude chargée depuis .env');
    console.log('   ✅ CORS activé pour accepter les requêtes frontend');
    console.log('');
    console.log('⚠️   Pour arrêter : Ctrl+C');
    console.log('');
});
