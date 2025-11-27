import { track } from "@amplitude/analytics-node";
import { DateTime } from "luxon";
import axios from "../config/axios";

export function delay(time = 1000) {
    return new Promise((resolve) => {
        setTimeout(() => {
            return resolve(true);
        }, time)
    });
}
