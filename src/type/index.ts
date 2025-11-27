import { User } from "./user";

declare global {
    namespace Express {
        interface Response {
            locals: {
                user?: User;
            }
        }
    }
}

