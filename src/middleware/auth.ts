import { NextFunction, Request, RequestHandler, RequestParamHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import logger from '../service/logger';
import { ApiError } from '../error/api-error';
export enum AuthMethod {
    TOKEN = "token",
    API_KEY = "apiKey",
    NONE = "none"
}
interface TokenData {
    "ip": string,
    "org": {
        "id": string,
        "name": string
    },
    "user": {
        "id": string
        "meta": string
        "email": string
    },
    "userEmail": string
};
declare global {
    namespace Express {
        interface Response {
            locals: {
                user?: null;
            }
        }
    }
}
export function auth(authMethods: AuthMethod[] = [AuthMethod.API_KEY]) {
    return async function (req: Request, res: Response, next: NextFunction) {
        const methods = [...authMethods];
        let done = false;
        while (methods.length > 0 && !done) {
            const method = methods.shift();
            logger.info(`Authenticating with ${method}...`);
            try {
                switch (method) {
                    case 'token':
                        throw new ApiError('Not Implemented', 501);
                        done = true;
                        break;
                    case 'apiKey':
                        await apiKeyAuth(req, res, next);
                        done = true;
                        break;
                    case 'none':
                        done = true;
                        next();
                        break;
                    default:
                        done = true;
                        next(new ApiError('Authentication failed. Please authenticate yourself.', 401));
                        break;


                }
            } catch (error) {
                logger.error(error);
                if (methods.length == 0) {
                    next(error);
                }
            }
        }
    }
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
    let apiKey = req.header('x-api-key') ? req.header('x-api-key') : req.query.apiKey?.toString();
    if (apiKey && apiKey === process.env.MASTER_API_KEY) {
        next();
    } else {
        throw new ApiError('API Key not found', 401);
    }
}
