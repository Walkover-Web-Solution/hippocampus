import { BigQuery } from '@google-cloud/bigquery';
import env from './env';
import logger from '../service/logger';

/**
 * BigQuery client configuration.
 *
 * Authentication is handled via inline service account credentials
 * (BQ_CLIENT_EMAIL, BQ_PRIVATE_KEY, BQ_CLIENT_ID) read from environment variables.
 */
const bigquery = new BigQuery({
    projectId: env.BQ_PROJECT_ID,
    credentials: {
        private_key: env.BQ_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: env.BQ_CLIENT_EMAIL,
        client_id: env.BQ_CLIENT_ID,
    },
});

logger.info(`[BIGQUERY] Client initialized for project: ${env.BQ_PROJECT_ID || '(default)'}`);

export default bigquery;
