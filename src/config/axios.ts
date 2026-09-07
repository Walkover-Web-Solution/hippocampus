import axios from "axios";
import http from "http";
import https from "https";
import logger from "../service/logger";

// Create an HTTP agent with Keep-Alive enabled
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// Without this a hung server never errors, so the interceptor below never runs.
const REQUEST_TIMEOUT = 120 * 1000;

const RETRYABLE_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'];

// Create an Axios instance with custom agents
const axiosInstance = axios.create({
    httpAgent: httpAgent,
    httpsAgent: httpsAgent,
    timeout: REQUEST_TIMEOUT
});

// Idempotent: re-running it on an already-swapped url is a no-op.
function swapToBackup(url: string, backupBaseURL: string): string {
    const { pathname, search } = new URL(url);
    return new URL(pathname + search, backupBaseURL).toString();
}

axiosInstance.interceptors.response.use(
    response => response, // Return successful responses directly
    async error => {
        const config = error.config;

        // If config does not exist or the retry option is not set, reject
        if (!config || !config.retry) return Promise.reject(error);

        // Check if we have retried the max amount
        config.__retryCount = config.__retryCount || 0;
        if (config.__retryCount >= config.retry) return Promise.reject(error);

        // Condition for retry
        const shouldRetry = (error.response && error.response.status >= 500) || RETRYABLE_CODES.includes(error.code);
        if (shouldRetry) {
            config.__retryCount += 1;

            if (config.backupBaseURL) {
                const backupUrl = swapToBackup(config.url, config.backupBaseURL);
                if (backupUrl !== config.url) {
                    logger.warn(`${config.url} failed (${error.code || error.response?.status}), failing over to ${backupUrl}`);
                    config.url = backupUrl;
                }
            }

            // Create a delay (backoff)
            const backoff = new Promise(resolve => {
                setTimeout(() => resolve(true), 1000 * config.__retryCount);
            });

            await backoff;
            return axiosInstance(config);
        }

        return Promise.reject(error);
    }
);

export default axiosInstance;
