import * as express from 'express';
import { Express } from 'express';

const FakeHttpServer: Express = express();
FakeHttpServer.disable('x-powered-by');
FakeHttpServer.use(express.json());
FakeHttpServer.use(express.urlencoded({ extended: true }));

FakeHttpServer.all('/api', (_, res) => res.send('body'));

FakeHttpServer.get('/timeout', (_, res) =>
  setTimeout(() => res.send('body'), 1000),
);

FakeHttpServer.all('/param', (req, res) =>
  res.json({ query: req.query, body: req.body }),
);

export default FakeHttpServer;
