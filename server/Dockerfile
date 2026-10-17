FROM node:22-alpine
WORKDIR /srv
ENV NODE_ENV=production
COPY . .
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /srv
USER app
EXPOSE 8080
CMD ["node","control-api.js"]
