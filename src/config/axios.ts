import axios from "axios";
import http from "http";
import https from "https";

// Create an HTTP agent with Keep-Alive enabled
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// Create an Axios instance with custom agents
const axiosInstance = axios.create({
    httpAgent: httpAgent,
    httpsAgent: httpsAgent
});

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
        const shouldRetry = (error.response && error.response.status >= 500) || error.code === 'ECONNRESET';
        if (shouldRetry) {
            config.__retryCount += 1;

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