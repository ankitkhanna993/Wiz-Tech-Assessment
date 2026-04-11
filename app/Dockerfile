# ============================================================
# Wiz Exercise - Todo App Dockerfile
# Base image: node:16 (older but functional)
# Embeds wizexercise.txt with your name as required
# ============================================================
FROM node:16-alpine

WORKDIR /app

# Exercise requirement: embed wizexercise.txt with your name
# Replace "Your Full Name" with your actual name
RUN echo "Ankit Khanna" > /app/wizexercise.txt

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application source
COPY . .

# Expose application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

# Run the application
CMD ["node", "server.js"]
