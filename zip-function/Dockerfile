FROM public.ecr.aws/lambda/nodejs:24 AS builder

WORKDIR /usr/app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY app.ts ./
RUN npm run build

FROM public.ecr.aws/lambda/nodejs:24

WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=builder /usr/app/dist/ ./

CMD ["app.lambdaHandler"]
