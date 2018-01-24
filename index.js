import dotenv from 'dotenv'
import http from 'http'
import express from 'express'
import postgraphql from 'postgraphql'
import winston from 'winston'
import expressWinston from 'express-winston'
import cors from 'cors'
import compression from 'compression'
import helmet from 'helmet'
import hpp from 'hpp'
import throng from 'throng'
import Raven from 'raven'
const client = require('prom-client')

dotenv.config()

const DefaultServerConfig = {
  nodeEnv: process.env.NODE_ENV,
  port: process.env.PORT,
  timeout: 28000,
  schemaName: process.env.SCHEMA_NAME,
  databaseUrl: process.env.DATABASE_URL,
  sentryDns: process.env.SENTRY_DSN
}

const defaultLabels = { serviceName: 'bonde_graphql_' + process.env.SCHEMA_NAME };
client.register.setDefaultLabels(defaultLabels);
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ timeout: 5000 }); // Probe every 5th second.

export const createServer = (config) => {
  const __PROD__ = config.nodeEnv === 'production'

  const optionsPostgraph = {
    jwtSecret: process.env.JWT_SECRET,
    jwtPgTypeIdentifier: process.env.JWT_TYPE,
    pgDefaultRole: process.env.PG_DEFAULT_ROLE,
    watchPg: true
  }
  if (!__PROD__) {
    optionsPostgraph.graphiql = true
  }

  const app = express()

  if (__PROD__) {
    Raven.config(config.sentryDns).install()
    app.use(Raven.requestHandler())
  }

  app.use(expressWinston.logger({
    transports: [
      new winston.transports.Console({ colorize: true })
    ],
    msg: 'HTTP {{req.method}} {{req.url}}',
    expressFormat: true,
    colorize: true
  }))
  app.use(cors())
  app.use(helmet())
  app.use(hpp())
  app.use(compression())

  app.get('/metrics', (req, res) => res.end(client.register.metrics()))

  app.use(postgraphql(config.databaseUrl, config.schemaName, optionsPostgraph))

  app.use(expressWinston.errorLogger({
    transports: [
      new winston.transports.Console({ colorize: true })
    ]
  }))

  if (__PROD__) { app.use(Raven.errorHandler()) }

  const server = http.createServer(app)

  // Heroku dynos automatically timeout after 30s. Set our
  // own timeout here to force sockets to close before that.
  // https://devcenter.heroku.com/articles/request-timeout
  if (config.timeout) {
    server.setTimeout(config.timeout, (socket) => {
      const message = `Timeout of ${config.timeout}ms exceeded`

      socket.end([
        'HTTP/1.1 503 Service Unavailable',
        `Date: ${(new Date).toGMTString()}`,  // eslint-disable-line
        'Content-Type: text/plain',
        `Content-Length: ${message.length}`,
        'Connection: close',
        '',
        message
      ].join(`\r\n`))
    })
  }

  return server
}

const startServer = (serverConfig) => {
  const config = { ...DefaultServerConfig, ...serverConfig }

  const server = createServer(config)
  server.listen(config.port, (err) => {
    if (err) winston.log(err)
    winston.info(`server ${config.id} listening on port ${config.port}`)
  })
}

if (require.main === module) {
  throng({
    start: (id) => startServer({ id }),
    workers: process.env.WEB_CONCURRENCY || 1,
    lifetime: Infinity
  })
}
