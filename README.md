# Hippocampus: RAG as a Service

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-v18%2B-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)
![Docker](https://img.shields.io/badge/docker-ready-blue)

**Hippocampus** is a powerful backend service designed to power your core **Retrieval Augmented Generation (RAG)** workflows. It bridges the gap between your raw data and your LLM, handling chunks, embeddings, and retrieval.

---

## Quick Start (Docker)

The fastest way to run Hippocampus is using Docker.

1.  **Configure Environment**:
    ```bash
    cp .env.example .env
    # Fill in your keys in .env
    ```

2.  **Run**:
    ```bash
    docker build -t hippocampus .
    docker run -p 4477:4477 --env-file .env hippocampus
    ```

The service will be available at `http://localhost:4477`.

---

## Manual Setup (Development)

1.  **Prerequisites**: Node.js v18+, MongoDB.
2.  **Install**: `npm install`
3.  **Run Dev Server**: `npm run dev`
4.  **Production Build**: `npm run build && npm start`
5.  **RAG Sync Job**: `npm run rag-sync`

---

## Configuration

The application is configured via environment variables in the `.env` file. A template is provided in `.env.example`.

```properties
PORT=4477
MONGODB_CONNECTION_URI=
MONGODB_DB_NAME=
REDIS_CONNECTION_STRING=
QUEUE_CONNECTIONURL=
AI_MIDDLEWARE_AUTH_KEY=
OPENAI_API_KEY=
QDRANT_URL=
QDRANT_API_KEY=
QDRANT_COLLECTION_NAME=
```

---

## API Documentation

View the full API documentation on Postman:
**[View API Documentation](https://www.postman.com/cloudvulture/rag-service/collection/6unm4q7/api-documentation)**

---

## Key Features

*   **Collection Management**: Logical grouping of resources with custom settings.
    *   **Collection**: A logical grouping of resources with specific encoder and chunking settings.
    *   **Resource**: A document or content piece (PDF, URL, etc.) within a collection.
    *   **Chunk**: Smaller, vector-ready parts of a resource used for retrieval.
*   **Smart Chunking**: Intelligent splitting of PDFs, Google Docs, functionality for RAG.
*   **Multi-Source Ingestion**:
    *   **Files**: PDF, Text.
    *   **Web**: Scraping via Puppeteer.
    *   **YouTube**: Transcripts.
*   **High Performance**: Built with Node.js and FastEmbed for efficient processing.
*   **Vector Search**: Seamless integration with Qdrant.

---

## Testing

The project uses Jest for testing. Tests are located in the `src/__tests__` directory.

### Unit Tests
To run the standard unit test suite:
```bash
npm test
```

### Watch Mode
For development, you can run tests in watch mode to automatically re-run tests on file changes:
```bash
npm run test:watch
```

---

## Tech Stack

*   **Node.js & TypeScript**
*   **MongoDB (Mongoose)**
*   **Qdrant (Vector DB)**
*   **RabbitMQ (Queues)**
*   **Langchain & OpenAI**

---

## Development Conventions

*   **Language**: TypeScript
*   **Framework**: Express.js
*   **ORM/ODM**: Mongoose (for MongoDB)
*   **Project Structure**: Follows a typical Node.js/Express project structure with separate directories for `config`, `consumer`, `error`, `job`, `middleware`, `models`, `route`, `service`, `type`, and `utility`.
*   **Authentication**: API key based authentication is used for routes.
*   **Logging**: Uses `winston` for logging.
*   **Queueing**: Uses `amqplib` for RabbitMQ integration.
*   **HTTP Client**: Uses `axios`.
*   **Web Scraping**: Uses `puppeteer-extra` and `cheerio`.
*   **Vector Embeddings/LLM Integration**: Uses `langchain` and `openai` libraries.

---

## Further Actions

*   Implement additional features related to RAG (e.g., actual embedding generation, retrieval logic).
*   Add comprehensive tests for the newly created services and routes.

---

*Built with ❤️ by the Walkover Team.*