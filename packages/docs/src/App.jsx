import { Brain, Search, History, Shield, Zap, Terminal, Code, Database, ArrowRight } from 'lucide-react'

const features = [
  { icon: Brain, title: 'Persistent Memory', desc: 'Agents remember across sessions. No more starting from scratch.' },
  { icon: Search, title: 'Semantic Search', desc: 'Find memories by meaning, not just keywords. Natural language recall.' },
  { icon: History, title: 'Version History', desc: 'Every update creates a version. Roll back to any point in time.' },
  { icon: Shield, title: 'Namespaces & ACL', desc: 'Isolate memories by project, agent, or team. Fine-grained access control.' },
  { icon: Zap, title: 'MCP Native', desc: 'Works with Claude Code, Cursor, Windsurf — any MCP-compatible agent.' },
  { icon: Database, title: 'Local or Cloud', desc: 'Run locally with SQLite for free. Scale to cloud when you need it.' },
]

const codeExamples = {
  mcp: `// claude_desktop_config.json or settings.json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["@agentmemory/mcp-server"]
    }
  }
}

// That's it. Your agent now has persistent memory.
// It can use memory_store, memory_search, memory_recall, etc.`,

  typescript: `import { AgentMemory } from '@agentmemory/sdk'

const memory = new AgentMemory({ apiKey: 'am_...' })

// Store a memory
await memory.store('my-project', 'architecture',
  'We use a microservices architecture with PostgreSQL and Redis',
  { tags: ['architecture', 'decision'] }
)

// Search later
const results = await memory.search('my-project', 'what database do we use?')
// Returns the architecture memory with relevance score`,

  python: `from agentmemory import AgentMemory

memory = AgentMemory(api_key="am_...")

# Store a memory
memory.store("my-project", "architecture",
    "We use a microservices architecture with PostgreSQL and Redis",
    tags=["architecture", "decision"]
)

# Search later
results = memory.search("my-project", "what database do we use?")
# Returns the architecture memory with relevance score`,
}

export default function App() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Nav */}
      <nav className="border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-4 flex justify-between items-center h-16">
          <div className="flex items-center gap-2">
            <Brain className="text-brand-600" size={24} />
            <span className="text-xl font-bold">AgentMemory</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#features" className="text-sm text-gray-600 hover:text-gray-900">Features</a>
            <a href="#quickstart" className="text-sm text-gray-600 hover:text-gray-900">Quick Start</a>
            <a href="#pricing" className="text-sm text-gray-600 hover:text-gray-900">Pricing</a>
            <a href="#api" className="text-sm text-gray-600 hover:text-gray-900">API Docs</a>
            <button className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-700">
              Get API Key
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="py-24 text-center bg-gradient-to-b from-brand-50 to-white">
        <div className="max-w-3xl mx-auto px-4">
          <div className="inline-flex items-center gap-2 bg-brand-100 text-brand-700 px-3 py-1 rounded-full text-sm mb-6">
            <Zap size={14} /> Now available as an MCP server
          </div>
          <h1 className="text-5xl font-bold mb-6 leading-tight">
            Give your AI agents<br />
            <span className="text-brand-600">permanent memory</span>
          </h1>
          <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
            Agents forget everything between sessions. AgentMemory gives them persistent,
            searchable, versioned memory — so they learn and improve over time.
          </p>
          <div className="flex justify-center gap-4">
            <button className="bg-brand-600 text-white px-8 py-3 rounded-lg text-lg font-medium hover:bg-brand-700 flex items-center gap-2">
              Get Started Free <ArrowRight size={18} />
            </button>
            <a href="#quickstart" className="border border-gray-300 px-8 py-3 rounded-lg text-lg font-medium hover:bg-gray-50 flex items-center gap-2">
              <Terminal size={18} /> Quick Start
            </a>
          </div>
          <p className="mt-4 text-sm text-gray-500">Free tier: 1,000 memories, 10,000 searches/month</p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-4">Built for the agent era</h2>
          <p className="text-center text-gray-600 mb-12 max-w-2xl mx-auto">
            Not another vector database. AgentMemory is purpose-built for AI agents —
            with namespaces, versioning, and semantic search out of the box.
          </p>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {features.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="p-6 rounded-xl border border-gray-100 hover:border-brand-200 hover:shadow-sm transition-all">
                <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center mb-4">
                  <Icon className="text-brand-600" size={20} />
                </div>
                <h3 className="font-semibold mb-2">{title}</h3>
                <p className="text-sm text-gray-600">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Quick Start */}
      <section id="quickstart" className="py-20 bg-gray-50">
        <div className="max-w-4xl mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-4">Get started in 30 seconds</h2>
          <p className="text-center text-gray-600 mb-12">Choose your integration method</p>

          <div className="space-y-8">
            {/* MCP */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Terminal className="text-brand-600" size={18} />
                <h3 className="font-semibold">MCP Server (Claude Code, Cursor, Windsurf)</h3>
              </div>
              <pre className="bg-gray-900 text-green-400 p-6 rounded-xl overflow-x-auto text-sm leading-relaxed">
                {codeExamples.mcp}
              </pre>
            </div>

            {/* TypeScript */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Code className="text-brand-600" size={18} />
                <h3 className="font-semibold">TypeScript SDK</h3>
                <code className="text-xs bg-gray-200 px-2 py-1 rounded">npm install @agentmemory/sdk</code>
              </div>
              <pre className="bg-gray-900 text-green-400 p-6 rounded-xl overflow-x-auto text-sm leading-relaxed">
                {codeExamples.typescript}
              </pre>
            </div>

            {/* Python */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Code className="text-brand-600" size={18} />
                <h3 className="font-semibold">Python SDK</h3>
                <code className="text-xs bg-gray-200 px-2 py-1 rounded">pip install agentmemory</code>
              </div>
              <pre className="bg-gray-900 text-green-400 p-6 rounded-xl overflow-x-auto text-sm leading-relaxed">
                {codeExamples.python}
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* API Reference */}
      <section id="api" className="py-20">
        <div className="max-w-4xl mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">API Reference</h2>
          <div className="space-y-4">
            {[
              { method: 'POST', path: '/v1/memory/store', desc: 'Store a new memory in a namespace' },
              { method: 'GET', path: '/v1/memory/search', desc: 'Search memories by natural language query' },
              { method: 'GET', path: '/v1/memory/recall', desc: 'Recall a specific memory by key' },
              { method: 'PUT', path: '/v1/memory/update', desc: 'Update a memory (creates new version)' },
              { method: 'DELETE', path: '/v1/memory/forget', desc: 'Delete a memory permanently' },
              { method: 'GET', path: '/v1/memory/list', desc: 'List all memories in a namespace' },
              { method: 'GET', path: '/v1/namespaces', desc: 'List all namespaces' },
            ].map(({ method, path, desc }) => (
              <div key={path} className="flex items-center gap-4 p-4 border border-gray-200 rounded-lg">
                <span className={`text-xs font-mono font-bold px-2 py-1 rounded ${
                  method === 'POST' ? 'bg-green-100 text-green-700' :
                  method === 'PUT' ? 'bg-yellow-100 text-yellow-700' :
                  method === 'DELETE' ? 'bg-red-100 text-red-700' :
                  'bg-blue-100 text-blue-700'
                }`}>{method}</span>
                <code className="text-sm font-mono">{path}</code>
                <span className="text-sm text-gray-500 ml-auto">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 bg-gray-50">
        <div className="max-w-4xl mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-12">Pricing</h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="bg-white border border-gray-200 rounded-xl p-8">
              <h3 className="text-lg font-semibold mb-2">Free</h3>
              <p className="text-4xl font-bold mb-1">$0</p>
              <p className="text-sm text-gray-500 mb-6">forever</p>
              <ul className="text-sm text-gray-600 space-y-2 mb-6 text-left">
                <li>1,000 memories</li>
                <li>10,000 searches/month</li>
                <li>1 namespace</li>
                <li>Local MCP server (unlimited)</li>
                <li>Community support</li>
              </ul>
              <button className="w-full border border-brand-600 text-brand-600 py-2 rounded-lg hover:bg-brand-50">
                Get Started
              </button>
            </div>
            <div className="bg-white border-2 border-brand-600 rounded-xl p-8 relative">
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-600 text-white text-xs px-3 py-1 rounded-full">
                Most Popular
              </span>
              <h3 className="text-lg font-semibold mb-2">Pro</h3>
              <p className="text-4xl font-bold mb-1">$29<span className="text-lg text-gray-500">/mo</span></p>
              <p className="text-sm text-gray-500 mb-6">per workspace</p>
              <ul className="text-sm text-gray-600 space-y-2 mb-6 text-left">
                <li>100,000 memories</li>
                <li>Unlimited searches</li>
                <li>Unlimited namespaces</li>
                <li>Version history (90 days)</li>
                <li>Team access controls</li>
                <li>Webhook integrations</li>
                <li>Priority support</li>
              </ul>
              <button className="w-full bg-brand-600 text-white py-2 rounded-lg hover:bg-brand-700">
                Start Free Trial
              </button>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-8">
              <h3 className="text-lg font-semibold mb-2">Enterprise</h3>
              <p className="text-4xl font-bold mb-1">Custom</p>
              <p className="text-sm text-gray-500 mb-6">volume pricing</p>
              <ul className="text-sm text-gray-600 space-y-2 mb-6 text-left">
                <li>Unlimited everything</li>
                <li>Self-hosted option</li>
                <li>SSO / SAML</li>
                <li>Audit logs</li>
                <li>SLA guarantee</li>
                <li>Dedicated support</li>
                <li>Custom integrations</li>
              </ul>
              <button className="w-full border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50">
                Contact Sales
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 py-8">
        <div className="max-w-6xl mx-auto px-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Brain className="text-brand-600" size={18} />
            <span className="font-semibold">AgentMemory</span>
          </div>
          <p className="text-sm text-gray-500">&copy; 2026 AgentMemory. Memory infrastructure for AI agents.</p>
        </div>
      </footer>
    </div>
  )
}
