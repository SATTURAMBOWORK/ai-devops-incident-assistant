# AI DevOps Incident Assistant

Paste application or Docker logs (plus optional CPU / memory / request-count /
error-rate metrics) and get back a structured incident analysis: summary, likely
root cause, supporting evidence, severity, troubleshooting steps and a confidence
score. Past analyses are stored and browsable.

Each analysis combines three independent signals:

1. **RAG retrieval** - the logs are embedded and matched against a runbook of 13
   known incident patterns.
2. **LLM analysis** - the logs, metrics and matched runbook steps go to an LLM,
   which returns validated structured JSON, so the suggested steps cite
   documented procedures.
3. **Our own trained classifier** - a Python service predicts the incident
   category in milliseconds, with no API cost. The UI shows whether it agrees
   with retrieval; disagreements are the incidents most worth a second look.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite, served by nginx |
| Backend | Node.js 22 + Express 5 (ESM), Zod validation |
| Database | MongoDB + Mongoose |
| LLM | Groq (`openai/gpt-oss-120b`) |
| Embeddings | Voyage AI (`voyage-4-lite`) |
| ML service | Python 3.12, scikit-learn (TF-IDF + Logistic Regression), FastAPI |
| Infra | Docker + Docker Compose |
| CI/CD | GitHub Actions |

## Architecture

```mermaid
flowchart LR
    B[Browser] --> N[nginx<br/>frontend container]
    N -- /api --> API[Express backend]
    API --> DB[(MongoDB)]
    API -- embed logs --> V[Voyage AI]
    API -- analyze --> G[Groq LLM]
    API -- classify --> ML[ML service<br/>FastAPI + scikit-learn]
```

The ML service is **optional**: if it is down or unsure, the analysis still
completes, just without the predicted category. Retrieval and the LLM are
required.

## Structure

```
backend/    Express API - retrieval, LLM analysis, classifier client, persistence
frontend/   React dashboard - analyze, history and incident pages
ml/         Python classifier - data preparation, training, FastAPI service, tests
docker/     Dockerfiles + nginx config
.github/    CI/CD workflow
```

## Running with Docker Compose

Needs Docker and API keys for Voyage and Groq.

```bash
cp backend/.env.example backend/.env    # fill in VOYAGE_API_KEY and GROQ_API_KEY
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:8080 | The app |
| http://localhost:5000/api/health | Backend health (503 if the database is down) |
| http://localhost:8000/docs | ML service API docs |

Compose runs its own MongoDB with a named volume, and overrides `MONGO_URI` and
`ML_SERVICE_URL` from `.env` to point at the containers - so the same `.env`
works for local development too. `docker compose down -v` also deletes the data.

## Running locally (without Docker)

**Backend** - http://localhost:5000

```bash
cd backend
cp .env.example .env     # fill in MONGO_URI (e.g. MongoDB Atlas) and the API keys
npm install
npm run dev
```

**Frontend** - http://localhost:5173 (proxies `/api` to the backend)

```bash
cd frontend
npm install
npm run dev
```

**ML service** - http://localhost:8000 (optional)

```bash
cd ml
python -m venv .venv
.venv/Scripts/activate            # Windows; on macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python train.py                   # writes model.joblib (~1 minute)
uvicorn main:app --reload --port 8000
```

## Tests

```bash
cd backend && npm test                                    # Node test runner, fakes for Voyage/Groq, in-memory MongoDB
cd ml && python -m unittest discover -s tests -t . -v    # fake model, no training needed
```

No API keys are needed to run the tests.

## CI

```mermaid
flowchart LR
    BT[Backend tests] --> D[Build 3 Docker images]
    MT[ML tests + training] --> D
    FB[Frontend build] --> D
    D -- push to main only --> P[Push to GHCR<br/>sha- and latest tags]
```

[`ci-cd.yml`](.github/workflows/ci-cd.yml) runs on every push and pull request:
backend tests, ML tests plus a full training run, and a frontend build run in
parallel. Only if all three pass are the backend, frontend and ML images built,
so a pull request also proves the Dockerfiles still work. For a push to `main`
the images are pushed to GitHub Container Registry, tagged with the commit
(`sha-abc1234`) and `latest`.

Deployment is out of scope: the pipeline stops at tested, ready-to-run images.

## The ML classifier

### Categories

13 incident categories, each with a runbook entry in
[`backend/src/knowledge/runbook.js`](backend/src/knowledge/runbook.js):

`oom-killed`, `db-connection-refused`, `disk-full`, `port-in-use`, `crash-loop`,
`ssl-cert-expired`, `high-latency`, `error-rate-spike`, `dns-resolution-failure`,
`permission-denied`, `missing-config`, `too-many-open-files`, `auth-brute-force`

A category names the **root cause**, not the symptom: a crash loop caused by a
missing environment variable is `missing-config`. A test checks that every
category exists in the training data, the runbook and the frontend.

### Data

| Source | Rows | Notes |
|---|---|---|
| [`ml/data/incidents.jsonl`](ml/data/incidents.jsonl) | 496 | Hand-written, ~40 per category, varied across Node, Python, Go, Java, nginx, Docker, Kubernetes |
| [`ml/data/loghub_incidents.jsonl`](ml/data/loghub_incidents.jsonl) | 80 | **Real** incidents from [Loghub](https://github.com/logpai/loghub): 40 kernel OOM kills (Linux) and 40 SSH brute-force attacks |
| [`ml/data/noise_lines.txt`](ml/data/noise_lines.txt) | 1,764 lines | Real healthy log lines from Loghub Apache, Linux and SSH logs, with every line mentioning any category filtered out |

The Loghub files are distilled once by `prepare_loghub.py` (raw logs go in
`ml/data/loghub/`, gitignored). Only the small outputs are committed, so training
and the Docker build never need the ~80MB raw files.

### Training

[`augment.py`](ml/augment.py) buries each incident among real noise lines (3 noisy
copies per incident) and generates an `unknown` class of healthy logs.
[`train.py`](ml/train.py) **splits before augmenting**, so noisy copies of one
incident never land on both sides of the train/test split.

Classifying a whole log as one bag of words let a few error lines be diluted by
dozens of normal ones. [`predict.py`](ml/predict.py) instead scores every 3-line
window and keeps the strongest incident signal, answering "no prediction" when
nothing reaches 40% confidence. Training and the API both use this file, so the
reported accuracy is the accuracy served.

### Results (held-out test set)

| Kind of log | Whole-log model | Windowed model (shipped) |
|---|---|---|
| Error buried in noise | 46% | **69%** |
| Healthy log → no prediction | 53% | **86%** |
| Clean error snippet | 83% | 78% |
| 5-fold cross-validation | 56% | **70%** |

When the model is wrong it mostly returns *no prediction* rather than a wrong
category: precision is 0.8-1.0 for most categories.

### Known limitations

- 11 of 13 categories rely on hand-written examples; only `oom-killed` and
  `auth-brute-force` have real data. Accuracy on real production logs will be
  lower than the numbers above.
- `crash-loop`, `dns-resolution-failure` and `missing-config` have the lowest
  recall (~50%).
- Numbers are masked during training, which also hides useful codes such as
  `500`, `504` and exit code `137`.
- 85% of noise comes from one Linux server, so the `unknown` class partly keys
  on that server's hostname.

## Build progress

- [x] Step 1 - Express server, health check, central error handling
- [x] Step 2 - MongoDB connection + Incident model
- [x] Step 3 - Runbook knowledge base + embeddings + retrieval (RAG)
- [x] Step 4 - Analysis service (LLM)
- [x] Step 5 - Incident routes, controller, validation
- [x] Step 6 - Tests
- [x] Step 7 - React frontend
- [x] ML classifier service - data, training, windowed prediction, tests
- [x] Step 8 - Docker + Compose
- [x] Step 9 - GitHub Actions CI (tests, frontend build, Docker image build and push)
