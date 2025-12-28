# Backend Undefined (Codentis)

Backend API sécurisé pour gérer les communications avec l'API Claude.

## 🚀 Installation

```bash
# Installer les dépendances
npm install
```

## ⚙️ Configuration

1. Copier le fichier `.env.example` en `.env`:
```bash
cp .env.example .env
```

2. Éditer `.env` et ajouter votre clé API Claude:
```
CLAUDE_API_KEY=votre_cle_api_ici
PORT=3000
```

## 🏃 Démarrage

### Développement
```bash
npm start
```

Le serveur démarre sur `http://localhost:3000`

### Avec auto-reload (dev)
```bash
npm run dev
```

## 📡 Endpoints

### Health Check
```
GET /health
```
Retourne le statut du serveur.

### Chat API
```
POST /api/chat
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "Bonjour" }
  ],
  "system": "Tu es un assistant..."
}
```

## 🔒 Sécurité

- ✅ Clé API stockée dans `.env` (jamais commitée)
- ✅ CORS configuré
- ✅ Validation des requêtes
- ✅ Gestion d'erreurs complète

## 📝 Notes

- Le fichier `.env` contient des secrets - **NE JAMAIS LE COMMITTER**
- Utiliser `.env.example` comme template
- Le backend doit être démarré **AVANT** d'utiliser le frontend
