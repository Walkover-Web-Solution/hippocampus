export class ApiError {

    message: string;
    code: number;
    type?: Errors;
    constructor(message: string, code: number, type?: Errors) {
        this.code = code;
        this.message = message;
        this.type = type;
    }

}

export enum Errors {
    Authorization = "Authorization",
    Authentication = "Authentication",
    InvalidRequest = "Invalid Request"
}
