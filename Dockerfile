FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# البيانات (المشاريع، المستخدمون، الصور) تُحفظ هنا - اربطها بـ volume خارجي
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
