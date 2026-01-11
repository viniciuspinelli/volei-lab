# Dockerfile para o backend Node.js do Vôlei
FROM node:18-alpine

# Diretório de trabalho
WORKDIR /app


# Copia os arquivos do backend
COPY backend/package*.json ./
COPY backend/server.js ./
COPY backend/confirmados.json ./
COPY backend/public ./public

# Instala dependências
RUN npm install --production

# Expõe a porta do serviço
EXPOSE 3001

# Comando para iniciar o servidor
CMD ["node", "server.js"]
