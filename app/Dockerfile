FROM public.ecr.aws/docker/library/node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 80
CMD ["node", "server.js"]
