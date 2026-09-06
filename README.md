# AI DevOps Incident Assistant

Paste application or Docker logs (plus optional CPU / memory / request-count /
error-rate metrics) and get back a structured incident analysis: summary, likely
root cause, supporting evidence, severity, troubleshooting steps and a confidence
score. Past analyses are stored and browsable.

Analyses are grounded with **RAG** - the logs are matched against a small runbook
of known incident patterns, and the retrieved entries are fed to the model as
context, so the suggested steps cite documented procedures.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite |
| Backend | Node.js + Express 5 (ESM) |
| Database | MongoDB + Mongoose |
| AI | Claude API, with embeddings for retrieval |
| Infra | Docker + Docker Compose |
| CI/CD | GitHub Actions |

## Structure

```
backend/    Express API - retrieval, LLM analysis, persistence
frontend/   React dashboard
docker/     Dockerfiles + nginx config
.github/    CI/CD workflow
```

## Running locally

```bash
cd backend
cp .env.example .env     # then fill in the values
npm install
npm run dev              # http://localhost:5000
```

Check it is alive:

```bash
curl http://localhost:5000/api/health
```

## Build progress

- [x] Step 1 - Express server, health check, central error handling
- [ ] Step 2 - MongoDB connection + Incident model
- [ ] Step 3 - Runbook knowledge base + embeddings + retrieval (RAG)
- [ ] Step 4 - Analysis service (Claude)
- [ ] Step 5 - Incident routes, controller, validation
- [ ] Step 6 - Tests
- [ ] Step 7 - React frontend
- [ ] Step 8 - Docker + Compose
- [ ] Step 9 - GitHub Actions
- [ ] Step 10 - Deploy
