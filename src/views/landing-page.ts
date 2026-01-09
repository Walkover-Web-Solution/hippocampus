export const landingPageHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hippocampus | RAG as a Service</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        :root {
            --primary: #2563eb;
            --bg: #ffffff;
            --text: #1f2937;
            --text-light: #6b7280;
            --card: #f9fafb;
            --border: #e5e7eb;
            --success: #10b981;
        }
        html, body {
            height: 100%;
            overflow: hidden;
        }
        body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background-color: var(--bg);
            color: var(--text);
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            max-width: 700px;
            padding: 2rem;
            text-align: center;
        }
        .hero {
            margin-bottom: 3rem;
        }
        .hero-label {
            display: inline-block;
            background: #eff6ff;
            color: var(--primary);
            padding: 0.5rem 1rem;
            border-radius: 2rem;
            font-size: 0.875rem;
            font-weight: 600;
            margin-bottom: 1.5rem;
        }
        h1 {
            font-size: 3.5rem;
            margin: 0 0 1rem 0;
            color: var(--text);
            font-weight: 700;
            line-height: 1.1;
        }
        .highlight {
            color: var(--primary);
        }
        .tagline {
            font-size: 1.25rem;
            color: var(--text-light);
            margin-bottom: 0.5rem;
            font-weight: 400;
            line-height: 1.6;
        }
        .subtitle {
            font-size: 1rem;
            color: var(--text-light);
            margin-bottom: 2.5rem;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 1rem;
            margin-bottom: 2.5rem;
        }
        .info-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 0.5rem;
            padding: 1rem;
        }
        .info-label {
            font-size: 0.875rem;
            color: var(--text-light);
            margin-bottom: 0.25rem;
        }
        .info-value {
            font-size: 1.125rem;
            font-weight: 600;
            color: var(--text);
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            color: var(--success);
            font-weight: 600;
        }
        .status-dot {
            width: 8px;
            height: 8px;
            background: var(--success);
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .btn-group {
            display: flex;
            gap: 1rem;
            justify-content: center;
        }
        .btn {
            padding: 0.875rem 1.75rem;
            border-radius: 0.5rem;
            text-decoration: none;
            font-size: 1rem;
            font-weight: 600;
            transition: all 0.2s;
            border: 2px solid transparent;
        }
        .btn-primary {
            background-color: var(--primary);
            color: white;
        }
        .btn-primary:hover {
            background-color: #1d4ed8;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
        }
        .btn-secondary {
            background-color: white;
            color: var(--text);
            border-color: var(--border);
        }
        .btn-secondary:hover {
            border-color: var(--primary);
            color: var(--primary);
            transform: translateY(-2px);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <span class="hero-label">RAG as a Service</span>
            <h1>Power Your AI with <span class="highlight">Hippocampus</span></h1>
            <p class="tagline">Intelligent retrieval augmented generation for modern applications</p>
            <p class="subtitle">Built with TypeScript, MongoDB, and Qdrant for production-grade RAG workflows</p>
        </div>
        
        <div class="info-grid">
            <div class="info-card">
                <div class="info-label">Status</div>
                <div class="info-value status-badge">
                    <span class="status-dot"></span>
                    Online
                </div>
            </div>
            <div class="info-card">
                <div class="info-label">Version</div>
                <div class="info-value">v1.0.0</div>
            </div>
            <div class="info-card">
                <div class="info-label">Port</div>
                <div class="info-value">4477</div>
            </div>
        </div>

        <div class="btn-group">
            <a target="_blank" href="/doc" class="btn btn-primary">Documentation</a>
            <a target="_blank" href="/feedback" class="btn btn-secondary">Feedback</a>
        </div>
    </div>
</body>
</html>`;
