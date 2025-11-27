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

export default axiosInstance;