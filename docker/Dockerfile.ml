# Build from the repo root so the ml/ folder is in context:
#   docker build -f docker/Dockerfile.ml -t incident-ml .

# 3.12-slim, matching the version used to train locally. "slim" drops compilers
# and docs but keeps the C libraries numpy and scipy need at runtime. The full
# image is ~1GB for no benefit; alpine would be smaller but uses musl instead of
# glibc, so pip cannot use the prebuilt numpy/scipy wheels and would try to
# compile them from source - a slow build that usually fails.
FROM python:3.12-slim

# Never write .pyc files, and never buffer stdout - without this, logs sit in a
# buffer and docker logs shows nothing until the process exits or crashes.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first, in their own layer. Docker caches layers, so as long as
# requirements.txt is unchanged this expensive step is skipped on every rebuild
# - even when train.py or main.py changed. Copying the source first would throw
# that cache away on every edit.
COPY ml/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application code and the dataset.
COPY ml/ ./

# Train during the build, so the image ships with a model inside it.
#
# The alternative - training at container startup - would make every restart
# slow and, worse, non-deterministic: a container restarting at 3am could end up
# serving a different model than its neighbour. Building it in means the image
# is the artifact: the same image always serves exactly the same model.
#
# This is also why model.joblib is gitignored. The dataset is the source of
# truth and lives in git; the model is a build output, like dist/.
RUN python train.py

# Run as a non-root user. If the process is ever compromised, it has no rights
# to modify the application code it is running.
RUN useradd --create-home --shell /bin/bash mluser && chown -R mluser:mluser /app
USER mluser

EXPOSE 8000

# Bind to 0.0.0.0, not 127.0.0.1. Inside a container, localhost means "this
# container only" - the port mapping would appear to work while every request
# was refused.
#
# No --reload here: that is a development flag that watches files and restarts.
# In production it wastes memory and can restart mid-request.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
