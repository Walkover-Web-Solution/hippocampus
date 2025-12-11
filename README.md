# Project: RAG as a Service Backend

## Project Overview

This project is a Retrieval Augmented Generation (RAG) as a Service backend. It's built with Node.js, Express.js, and TypeScript. MongoDB (via Mongoose) is used for data persistence. The service is designed to manage collections, resources (documents), and chunks of information, facilitating RAG operations. It integrates with external services for tasks like data crawling, vector embeddings (Langchain), and potentially agent-based processing.

The core entities are:
- **Collection**: A logical grouping of resources. Each collection can have its own settings, such as the encoder to use for vectorizing its resources, chunk size, and chunk overlap.
- **Resource**: A document or piece of content within a collection. Resources are broken down into multiple chunks for processing.
- **Chunk**: Smaller, digestible parts of a resource, used for vector storage and retrieval.

## Building and Running

The project uses TypeScript and `ts-node-dev` for development.

### Development

To run the project in development mode (with live reloading):

```bash
npm run dev
```

### Building

To compile the TypeScript code to JavaScript:

```bash
npm run build
```

### Starting (Production)

To start the compiled JavaScript application:

```bash
npm start
```

### Testing

To run unit tests:

```bash
npm test
```

To run tests in watch mode:

```bash
npm run test:watch
```

### RAG Synchronization Job

To run a specific RAG synchronization job:

```bash
npm run rag-sync
```

## Development Conventions

*   **Language:** TypeScript
*   **Framework:** Express.js
*   **ORM/ODM:** Mongoose (for MongoDB)
*   **Project Structure:** Follows a typical Node.js/Express project structure with separate directories for `config`, `consumer`, `error`, `job`, `middleware`, `models`, `route`, `service`, `type`, and `utility`.
*   **Authentication:** API key based authentication is used for routes.
*   **Environment Variables:** Uses `dotenv` for managing environment variables.
    *   `QDRANT_URL`: The URL for the Qdrant service.
    *   `QDRANT_API_KEY`: The API key for authenticating with Qdrant.
    *   `QDRANT_COLLECTION_NAME`: The name of the collection to use in Qdrant.
*   **Logging:** Uses `winston` for logging.
*   **Queueing:** Uses `amqplib` for RabbitMQ integration.
*   **HTTP Client:** Uses `axios`.
*   **Web Scraping:** Uses `puppeteer-extra` and `cheerio`.
*   **Vector Embeddings/LLM Integration:** Uses `langchain` and `openai` libraries.

## Further Actions

*   Implement additional features related to RAG (e.g., actual embedding generation, retrieval logic).
*   Add comprehensive tests for the newly created services and routes.