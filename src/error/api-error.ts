export class ApiError extends Error {

    code: number;
    type?: Errors;
    constructor(message: string, code: number, type?: Errors) {
        super(message);
        this.code = code;
        this.type = type;
        Object.setPrototypeOf(this, ApiError.prototype);
    }

}

export enum Errors {
    Authorization = "Authorization",
    Authentication = "Authentication",
    InvalidRequest = "Invalid Request"
}
