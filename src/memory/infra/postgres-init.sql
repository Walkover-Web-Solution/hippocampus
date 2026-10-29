-- One database per approach, so each approach's reset() only touches its own data.
CREATE DATABASE mem_claims;

\c mem_claims
CREATE EXTENSION IF NOT EXISTS vector;
