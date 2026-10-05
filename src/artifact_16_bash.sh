# Copy and configure environment variables
cp .env.example .env
# Edit .env with your Resend & Slack Webhook credentials
nano .env

# Spin up daemon in background
docker compose up -d --build

# View real-time log ingestion
docker compose logs -f