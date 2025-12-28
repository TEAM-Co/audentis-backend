# Documentation : Système de Rate Limiting & Anti-Abuse

## 🎯 Vue d'ensemble

Système complet de protection contre l'usage abusif de l'agent IA avec :
- **Quota** : 10 requêtes par jour par utilisateur
- **Identification** : Triple couche (IP + LocalStorage + Browser Fingerprint)
- **Détection d'abus** : 4 heuristiques automatiques
- **Formulaire de repli** : Contact en cas de limite atteinte
- **Alertes email** : Notifications automatiques des abus

## 🔧 Configuration

### Variables d'environnement (`.env`)

```bash
# Clé API Claude (requis)
CLAUDE_API_KEY=sk-ant-api03-xxxxx

# Clé API Admin pour endpoints d'administration (recommandé)
ADMIN_API_KEY=votre_cle_secrete_ici

# EmailJS pour alertes d'abus (optionnel)
EMAILJS_SERVICE_ID=service_xxxxx
EMAILJS_TEMPLATE_ID=template_xxxxx
EMAILJS_PUBLIC_KEY=xxxxxxxxx
EMAILJS_PRIVATE_KEY=xxxxxxxxx

# Port du serveur
PORT=3000
```

## 📊 Endpoints API

### 1. Chat Principal (avec rate limiting)

**Endpoint** : `POST /api/chat`

**Headers** :
```
Content-Type: application/json
```

**Body** :
```json
{
  "system": "Prompt système...",
  "messages": [
    {"role": "user", "content": "Question utilisateur"}
  ],
  "fingerprint": "fp_abc123xyz"
}
```

**Réponses** :
- `200 OK` : Requête réussie, quota incrémenté
- `429 Too Many Requests` : Quota dépassé (10/jour)
- `403 Forbidden` : Utilisateur bloqué
- `500 Internal Server Error` : Erreur API Claude

### 2. Bloquer/Débloquer un utilisateur

**Endpoint** : `POST /admin/block`

**Authentification** : Requise via header ou query param

**Headers** :
```
X-Admin-API-Key: votre_cle_admin
Content-Type: application/json
```

**Body** :
```json
{
  "userKey": "IP_fingerprint",
  "action": "block"  // ou "unblock"
}
```

**Exemple avec curl** :
```bash
# Bloquer un utilisateur
curl -X POST http://localhost:3000/admin/block \
  -H "X-Admin-API-Key: liwe_admin_2024_secure_key_d8f3k9s2" \
  -H "Content-Type: application/json" \
  -d '{"userKey":"123.45.67.89_fp_abc123","action":"block"}'

# Débloquer un utilisateur
curl -X POST http://localhost:3000/admin/block \
  -H "X-Admin-API-Key: liwe_admin_2024_secure_key_d8f3k9s2" \
  -H "Content-Type: application/json" \
  -d '{"userKey":"123.45.67.89_fp_abc123","action":"unblock"}'
```

**Réponses** :
- `200 OK` : Action réussie
- `401 Unauthorized` : Clé API manquante
- `403 Forbidden` : Clé API invalide
- `400 Bad Request` : Paramètres manquants

### 3. Consulter les activités suspectes

**Endpoint** : `GET /admin/suspicious`

**Authentification** : Requise

**Headers** :
```
X-Admin-API-Key: votre_cle_admin
```

**Exemple avec curl** :
```bash
curl http://localhost:3000/admin/suspicious \
  -H "X-Admin-API-Key: liwe_admin_2024_secure_key_d8f3k9s2"
```

**Réponse** :
```json
{
  "suspicious": [
    {
      "userKey": "123.45.67.89_fp_abc123",
      "ip": "123.45.67.89",
      "fingerprint": "fp_abc123",
      "reasons": [
        "10 requêtes en 2.3 minutes",
        "Questions identiques répétées"
      ],
      "detectedAt": "2024-01-15T14:30:00.000Z",
      "requests": [
        {
          "timestamp": "2024-01-15T14:28:00.000Z",
          "message": "test test test"
        }
      ]
    }
  ]
}
```

## 🚨 Détection d'Abus

### Heuristiques automatiques

Le système détecte automatiquement les comportements suspects :

1. **Haute fréquence** : 10 requêtes en moins de 5 minutes
2. **Questions identiques** : 3+ questions strictement identiques
3. **Questions trop courtes** : 3+ questions de moins de 5 caractères
4. **Spam/caractères aléatoires** : 2+ messages sans contenu cohérent

### Actions automatiques

Quand un abus est détecté :
1. ✅ Log dans la console serveur avec détails complets
2. ✅ Ajout à la liste des activités suspectes
3. ✅ Email d'alerte envoyé à `contact@audentis.fr` (si EmailJS configuré)
4. ⚠️ L'utilisateur n'est **PAS bloqué automatiquement** (décision manuelle)

### Email d'alerte

Format de l'email envoyé :
- **Sujet** : ALERTE ABUS - Agent IA Liwe
- **Contenu** :
  - IP et fingerprint de l'utilisateur
  - Raisons de l'alerte
  - Historique complet des requêtes
  - Commande curl pour bloquer l'utilisateur

## 🔐 Sécurité

### Authentification Admin

Les endpoints `/admin/*` sont protégés par clé API :

**Via Header (recommandé)** :
```bash
curl http://localhost:3000/admin/suspicious \
  -H "X-Admin-API-Key: YOUR_KEY"
```

**Via Query Param (alternatif)** :
```bash
curl http://localhost:3000/admin/suspicious?apiKey=YOUR_KEY
```

### Génération de clé sécurisée

Pour générer une nouvelle clé admin sécurisée :

```bash
# Générer une clé aléatoire (32 caractères)
openssl rand -hex 32
```

Puis ajouter dans `.env` :
```
ADMIN_API_KEY=votre_nouvelle_cle_generee
```

## 💾 Stockage des Données

### En Mémoire (RAM)

Les quotas et listes de blocage sont stockés en mémoire :

**Avantages** :
- ✅ Très rapide (pas d'I/O disque)
- ✅ Simple à implémenter
- ✅ Pas de dépendance externe

**Limitations** :
- ⚠️ Données perdues au redémarrage serveur
- ⚠️ Pas partagé entre plusieurs instances

**C'est acceptable car** :
- Les quotas se reset naturellement à minuit
- Un redémarrage serveur efface les compteurs (sécuritaire)
- Les blocages peuvent être réappliqués manuellement

### Migration vers Redis (optionnel)

Pour production avec haute disponibilité, envisager Redis :

```javascript
const redis = require('redis');
const client = redis.createClient();

// Remplacer Map par Redis
await client.set(`quota:${userKey}`, JSON.stringify(quotaData));
const quotaData = JSON.parse(await client.get(`quota:${userKey}`));
```

## 📝 Logs Console

### Logs normaux

```
📩 Nouvelle requête chat reçue
👤 Utilisateur: 123.45.67.89_fp_abc123 | IP: 123.45.67.89
📊 Quota incrémenté pour 123.45.67.89_fp_abc123: 3/10
✅ Réponse reçue de Claude
```

### Logs d'abus

```
🚨 ABUS DÉTECTÉ pour 123.45.67.89_fp_abc123: 10 requêtes en 2.3 minutes, Questions identiques répétées

🚨 ALERTE ABUS DÉTECTÉ - Agent IA Liwe
═══════════════════════════════════════════════════════
👤 UTILISATEUR SUSPECT
   Clé utilisateur : 123.45.67.89_fp_abc123
   Adresse IP      : 123.45.67.89
   Fingerprint     : fp_abc123
   ...
```

### Logs quota dépassé

```
⚠️ Quota dépassé pour: 123.45.67.89_fp_abc123 (10/10)
```

### Logs blocage

```
🚫 Utilisateur bloqué tenté d'accéder: 123.45.67.89_fp_abc123
```

## 🧪 Tests

### 1. Tester le quota

```bash
# Faire 11 requêtes rapidement
for i in {1..11}; do
  curl -X POST http://localhost:3000/api/chat \
    -H "Content-Type: application/json" \
    -d '{
      "system": "Test",
      "messages": [{"role":"user","content":"Test '$i'"}],
      "fingerprint": "fp_test123"
    }'
  echo "\nRequête $i terminée\n"
done

# La 11ème doit retourner 429 (quota dépassé)
```

### 2. Tester la détection d'abus

```bash
# Faire 10 requêtes identiques très rapidement
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/chat \
    -H "Content-Type: application/json" \
    -d '{
      "system": "Test",
      "messages": [{"role":"user","content":"test"}],
      "fingerprint": "fp_abuse123"
    }' &
done
wait

# Vérifier les logs serveur pour l'alerte abus
# Vérifier /admin/suspicious
```

### 3. Tester le blocage

```bash
# 1. Bloquer un utilisateur
curl -X POST http://localhost:3000/admin/block \
  -H "X-Admin-API-Key: liwe_admin_2024_secure_key_d8f3k9s2" \
  -H "Content-Type: application/json" \
  -d '{"userKey":"test_user","action":"block"}'

# 2. Essayer une requête avec cet utilisateur
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "system": "Test",
    "messages": [{"role":"user","content":"Test"}],
    "fingerprint": "test_user"
  }'

# Doit retourner 403 Forbidden
```

### 4. Tester l'authentification admin

```bash
# Sans clé API (doit échouer)
curl http://localhost:3000/admin/suspicious

# Avec mauvaise clé (doit échouer)
curl http://localhost:3000/admin/suspicious \
  -H "X-Admin-API-Key: wrong_key"

# Avec bonne clé (doit réussir)
curl http://localhost:3000/admin/suspicious \
  -H "X-Admin-API-Key: liwe_admin_2024_secure_key_d8f3k9s2"
```

## 🔄 Maintenance

### Nettoyage automatique

Les quotas expirés sont automatiquement nettoyés toutes les heures :

```javascript
setInterval(() => {
    const today = new Date().toISOString().split('T')[0];
    for (const [key, data] of userQuotas.entries()) {
        if (data.date !== today) {
            userQuotas.delete(key);
            console.log(`🧹 Quota expiré nettoyé pour: ${key}`);
        }
    }
}, 3600000); // 1 heure
```

### Reset manuel

Pour reset manuellement tous les quotas, redémarrer le serveur :

```bash
npm restart
```

## 📧 EmailJS

### Configuration

1. Créer un compte sur [EmailJS](https://www.emailjs.com/)
2. Créer un service email
3. Créer un template avec ces variables :
   - `to_email`
   - `site`
   - `prenom`
   - `nom`
   - `societe`
   - `email`
   - `telephone`
   - `conversation`
   - `timestamp`

4. Ajouter les clés dans `.env`

### Test manuel

```bash
curl -X POST https://api.emailjs.com/api/v1.0/email/send \
  -H "Content-Type: application/json" \
  -d '{
    "service_id": "service_fee83pn",
    "template_id": "template_so0n68q",
    "user_id": "pebJgpQP_xvUZim-M",
    "accessToken": "8YtL7qVQwZ-3sIHWx",
    "template_params": {
      "to_email": "contact@audentis.fr",
      "site": "TEST",
      "conversation": "Message de test"
    }
  }'
```

## ⚠️ Points d'Attention

1. **Quotas en mémoire** : Perdus au redémarrage (acceptable pour dev/staging)
2. **Clé admin** : À changer en production et garder secrète
3. **CORS** : Actuellement ouvert à tous, restreindre en production
4. **EmailJS** : Vérifier les limites du plan gratuit (200 emails/mois)
5. **Logs** : Les alertes d'abus sont loguées en clair avec IPs

## 🚀 Déploiement Production

Checklist avant mise en production :

- [ ] Changer `ADMIN_API_KEY` avec une clé sécurisée
- [ ] Configurer EmailJS pour alertes
- [ ] Restreindre CORS aux domaines autorisés
- [ ] Monitorer les logs d'abus
- [ ] Documenter la procédure de blocage d'utilisateurs
- [ ] Tester le formulaire de repli frontend
- [ ] Envisager Redis pour persistance des quotas
