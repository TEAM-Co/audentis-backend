// ==================== BUDGET TRACKER MODULE ====================
// Monthly budget tracking for Claude API usage with cost calculation

const fs = require('fs');
const path = require('path');

// Configuration
const BUDGET_FILE = path.join(__dirname, 'budget-data.json');
const MONTHLY_LIMIT = parseFloat(process.env.MONTHLY_BUDGET_LIMIT) || 25.00;
const SAFETY_MARGIN = 1.00; // Stop at $24 to prevent overage
const EFFECTIVE_LIMIT = MONTHLY_LIMIT - SAFETY_MARGIN;

// Alert thresholds (only trigger once)
const ALERT_THRESHOLDS = [
    { percentage: 60, amount: 15.00, sent: false },
    { percentage: 80, amount: 20.00, sent: false },
    { percentage: 92, amount: 23.00, sent: false }
];

// Claude Haiku pricing (per 1M tokens)
const PRICING = {
    INPUT_PER_MILLION: 0.25,
    OUTPUT_PER_MILLION: 1.25
};

// In-memory budget state
let budgetState = {
    currentMonth: null,        // 'YYYY-MM'
    totalCost: 0.00,          // Total spent this month
    requestCount: 0,           // Number of requests
    requests: [],              // Individual request logs
    alertsSent: [],            // [15, 20, 23] - thresholds crossed
    lastUpdated: null
};

// Initialize budget tracker
function initializeBudget() {
    loadBudgetFromFile();
    checkMonthRollover();
    console.log('💰 Budget Tracker initialized');
    console.log(`   Monthly limit: $${MONTHLY_LIMIT.toFixed(2)}`);
    console.log(`   Effective limit (with safety): $${EFFECTIVE_LIMIT.toFixed(2)}`);
    console.log(`   Current month: ${budgetState.currentMonth}`);
    console.log(`   Current cost: $${budgetState.totalCost.toFixed(4)}`);
}

// Load budget data from JSON file
function loadBudgetFromFile() {
    try {
        if (fs.existsSync(BUDGET_FILE)) {
            const data = fs.readFileSync(BUDGET_FILE, 'utf8');
            budgetState = JSON.parse(data);
            console.log('✅ Budget data loaded from file');
        } else {
            console.log('📝 No existing budget file, starting fresh');
            resetBudget();
        }
    } catch (error) {
        console.error('❌ Error loading budget file:', error);
        resetBudget();
    }
}

// Save budget data to JSON file
function saveBudgetToFile() {
    try {
        fs.writeFileSync(BUDGET_FILE, JSON.stringify(budgetState, null, 2), 'utf8');
    } catch (error) {
        console.error('❌ Error saving budget file:', error);
    }
}

// Get current month string (YYYY-MM in UTC)
function getCurrentMonth() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Check if month has rolled over and reset if needed
function checkMonthRollover() {
    const currentMonth = getCurrentMonth();

    if (budgetState.currentMonth !== currentMonth) {
        console.log(`📅 Month rollover detected: ${budgetState.currentMonth} → ${currentMonth}`);
        resetBudget();
    }
}

// Reset budget for new month
function resetBudget() {
    const previousCost = budgetState.totalCost;
    const previousCount = budgetState.requestCount;

    budgetState = {
        currentMonth: getCurrentMonth(),
        totalCost: 0.00,
        requestCount: 0,
        requests: [],
        alertsSent: [],
        lastUpdated: new Date().toISOString()
    };

    saveBudgetToFile();

    console.log('🔄 Budget reset for new month');
    console.log(`   Previous month total: $${previousCost?.toFixed(4) || '0.0000'}`);
    console.log(`   Previous month requests: ${previousCount || 0}`);
}

// Calculate cost from Claude API usage
function calculateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1_000_000) * PRICING.INPUT_PER_MILLION;
    const outputCost = (outputTokens / 1_000_000) * PRICING.OUTPUT_PER_MILLION;
    return inputCost + outputCost;
}

// Check if budget allows new request
function canMakeRequest() {
    checkMonthRollover();
    return budgetState.totalCost < EFFECTIVE_LIMIT;
}

// Get remaining budget
function getRemainingBudget() {
    return Math.max(0, EFFECTIVE_LIMIT - budgetState.totalCost);
}

// Get budget usage percentage
function getUsagePercentage() {
    return (budgetState.totalCost / MONTHLY_LIMIT) * 100;
}

// Track request cost after Claude API response
function trackRequestCost(inputTokens, outputTokens, userKey, message) {
    checkMonthRollover();

    const cost = calculateCost(inputTokens, outputTokens);

    budgetState.totalCost += cost;
    budgetState.requestCount += 1;
    budgetState.requests.push({
        timestamp: new Date().toISOString(),
        userKey: userKey,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cost: cost,
        message: message?.substring(0, 100) || ''
    });
    budgetState.lastUpdated = new Date().toISOString();

    // Keep only last 1000 requests to prevent file bloat
    if (budgetState.requests.length > 1000) {
        budgetState.requests = budgetState.requests.slice(-1000);
    }

    saveBudgetToFile();

    console.log(`💵 Request cost: $${cost.toFixed(6)} (${inputTokens} in, ${outputTokens} out)`);
    console.log(`📊 Monthly total: $${budgetState.totalCost.toFixed(4)} / $${MONTHLY_LIMIT.toFixed(2)} (${getUsagePercentage().toFixed(1)}%)`);

    // Check alert thresholds
    checkAlertThresholds();

    return cost;
}

// Check if any alert thresholds have been crossed
function checkAlertThresholds() {
    const currentCost = budgetState.totalCost;

    ALERT_THRESHOLDS.forEach(threshold => {
        if (currentCost >= threshold.amount && !budgetState.alertsSent.includes(threshold.amount)) {
            budgetState.alertsSent.push(threshold.amount);
            saveBudgetToFile();
            sendBudgetAlert(threshold.percentage, threshold.amount);
        }
    });
}

// Send budget alert email
async function sendBudgetAlert(percentage, thresholdAmount) {
    const usagePercentage = getUsagePercentage();
    const remainingBudget = getRemainingBudget();
    const daysIntoMonth = new Date().getUTCDate();
    const estimatedDaysUntilLimit = remainingBudget > 0
        ? Math.floor((remainingBudget / budgetState.totalCost) * daysIntoMonth)
        : 0;

    const alertMessage = `
🚨 ALERTE BUDGET API CLAUDE - ${percentage}%
═══════════════════════════════════════════════════════

💰 CONSOMMATION ACTUELLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Mois              : ${budgetState.currentMonth}
   Coût total        : $${budgetState.totalCost.toFixed(4)}
   Limite mensuelle  : $${MONTHLY_LIMIT.toFixed(2)}
   Budget restant    : $${remainingBudget.toFixed(4)}
   Utilisation       : ${usagePercentage.toFixed(1)}%

📊 STATISTIQUES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Nombre requêtes   : ${budgetState.requestCount}
   Coût moyen/req    : $${(budgetState.totalCost / budgetState.requestCount).toFixed(6)}
   Jours écoulés     : ${daysIntoMonth}
   Coût moyen/jour   : $${(budgetState.totalCost / daysIntoMonth).toFixed(4)}

⏱️ ESTIMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Jours jusqu'à limite : ~${estimatedDaysUntilLimit} jours
   ${remainingBudget < 1 ? '⚠️ BUDGET PRESQUE ÉPUISÉ!' : ''}

🔧 ACTION RECOMMANDÉE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Consultez le dashboard admin pour plus de détails :
GET http://localhost:3000/admin/budget

Pour réinitialiser le budget manuellement :
POST http://localhost:3000/admin/budget/reset

═══════════════════════════════════════════════════════
    `;

    console.warn(alertMessage);

    // Send email via EmailJS if configured
    const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
    const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
    const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
    const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

    if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY) {
        try {
            const fetch = require('node-fetch');

            const emailData = {
                to_email: 'contact@audentis.fr',
                site: `ALERTE BUDGET ${percentage}%`,
                prenom: 'Budget',
                nom: 'Tracker',
                societe: `$${budgetState.totalCost.toFixed(4)} / $${MONTHLY_LIMIT.toFixed(2)}`,
                email: `${budgetState.requestCount} requêtes`,
                telephone: budgetState.currentMonth,
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
                console.log(`✅ Email d'alerte budget ${percentage}% envoyé avec succès`);
            } else {
                console.error('❌ Erreur envoi email budget:', await response.text());
            }
        } catch (error) {
            console.error('❌ Erreur lors de l\'envoi de l\'email budget:', error);
        }
    } else {
        console.warn('⚠️ EmailJS non configuré - alerte budget non envoyée par email');
    }
}

// Get budget statistics
function getBudgetStats() {
    checkMonthRollover();

    // Daily breakdown
    const dailyBreakdown = {};
    budgetState.requests.forEach(req => {
        const day = req.timestamp.split('T')[0];
        if (!dailyBreakdown[day]) {
            dailyBreakdown[day] = { cost: 0, count: 0 };
        }
        dailyBreakdown[day].cost += req.cost;
        dailyBreakdown[day].count += 1;
    });

    return {
        currentMonth: budgetState.currentMonth,
        totalCost: budgetState.totalCost,
        monthlyLimit: MONTHLY_LIMIT,
        effectiveLimit: EFFECTIVE_LIMIT,
        remainingBudget: getRemainingBudget(),
        usagePercentage: getUsagePercentage(),
        requestCount: budgetState.requestCount,
        averageCostPerRequest: budgetState.requestCount > 0
            ? budgetState.totalCost / budgetState.requestCount
            : 0,
        alertsSent: budgetState.alertsSent,
        dailyBreakdown: dailyBreakdown,
        lastUpdated: budgetState.lastUpdated,
        recentRequests: budgetState.requests.slice(-10) // Last 10 requests
    };
}

// Manual budget reset (admin only)
function manualReset() {
    console.log('🔧 Manual budget reset triggered by admin');
    resetBudget();
}

module.exports = {
    initializeBudget,
    canMakeRequest,
    trackRequestCost,
    getBudgetStats,
    manualReset,
    getRemainingBudget,
    getUsagePercentage
};
