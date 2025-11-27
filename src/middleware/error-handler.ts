import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ApiError } from "../error/api-error";
import logger from "../service/logger";
import { APIResponseBuilder } from "../service/utility";


export default function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
    const responseBuilder = new APIResponseBuilder();
    if (err instanceof ApiError) {
        responseBuilder.setError(err.message, err.code);
        return res.status(err.code).json(responseBuilder.build());
    }
    if (err instanceof ZodError) {
        const message: any = {};
        (err.issues)?.forEach((e) => {
            message.field = e?.path[0];
            message.message = e?.message
        });
        responseBuilder.setError(JSON.stringify(message), 400);
        return res.status(400).json(responseBuilder.build());
    }
    // Default action for errors that are not handled.
    logger.error(err);
    responseBuilder.setError(err.message || 'Internal Server Error', 400);
    return res.status(400).json(responseBuilder.build());
}