import * as rTracer from 'cls-rtracer';
import { NextFunction, Request, Response } from 'express';

export function ClsMiddleware(req: Request, res: Response, next: NextFunction) {
  rTracer.expressMiddleware({ useHeader: true })(req, res, next);
}

export function getTransactionId() {
  return rTracer.id();
}
