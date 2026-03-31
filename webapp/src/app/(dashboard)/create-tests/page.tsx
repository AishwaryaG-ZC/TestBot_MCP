'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';

export default function CreateTestsPage() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="max-w-4xl mx-auto"
    >
      <h1 className="text-3xl font-bold text-[#F0F6FF] tracking-tight mb-8">
        Create Tests
      </h1>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.5 }}
        className="relative overflow-hidden backdrop-blur-xl bg-white/[0.03] border border-white/10 rounded-2xl p-8 hover:shadow-[0_0_30px_rgba(59,130,246,0.1)] transition-shadow duration-500"
      >
        {/* Gradient accent */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-blue-500 via-cyan-400 to-blue-500" />

        <div className="flex flex-col lg:flex-row items-center gap-8">
          {/* Illustration */}
          <div className="flex-shrink-0">
            <div className="w-32 h-32 rounded-2xl bg-gradient-to-br from-blue-500/20 to-cyan-400/10 border border-white/10 flex items-center justify-center">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" className="text-blue-400">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
              </svg>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 text-center lg:text-left">
            <h2 className="text-xl font-semibold text-[#F0F6FF] mb-3">
              Create Tests with Your AI Code Editor
            </h2>
            <p className="text-[#8BA4C8] mb-6 leading-relaxed">
              TestBot MCP integrates directly into your IDE. Simply type a natural language command
              and TestBot will auto-generate, run, and analyze tests for your project.
            </p>

            <div className="backdrop-blur-md bg-white/[0.04] border border-white/10 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-yellow-400">💡</span>
                <span className="text-sm text-[#8BA4C8]">Type this in your AI code editor:</span>
              </div>
              <p className="font-mono text-[#F0F6FF] text-sm">
                &ldquo;Hey, help me to test this project with TestBot MCP.&rdquo;
              </p>
            </div>

            <div className="flex flex-wrap gap-3 justify-center lg:justify-start">
              <Link
                href="/mcp-tests"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 via-cyan-400 to-blue-500 bg-[length:200%] text-black font-medium text-sm hover:bg-right transition-all duration-500 hover:shadow-[0_0_20px_rgba(59,130,246,0.3)]"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
                View MCP Setup
              </Link>
              <a
                href="#"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl backdrop-blur-md bg-white/[0.05] border border-white/10 text-[#F0F6FF] font-medium text-sm hover:bg-white/[0.08] transition-all duration-300"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                View Docs
              </a>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Quick start steps */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4"
      >
        {[
          { step: '1', title: 'Install MCP Server', desc: 'Add TestBot MCP to your IDE configuration' },
          { step: '2', title: 'Add API Key', desc: 'Generate and configure your API key' },
          { step: '3', title: 'Start Testing', desc: 'Type a command and let AI generate tests' },
        ].map((item, i) => (
          <motion.div
            key={item.step}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.1, duration: 0.4 }}
            className="backdrop-blur-xl bg-white/[0.03] border border-white/10 rounded-xl p-5 hover:shadow-[0_0_20px_rgba(59,130,246,0.1)] transition-all duration-300"
          >
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center text-white text-sm font-bold mb-3">
              {item.step}
            </div>
            <h3 className="text-[#F0F6FF] font-medium mb-1">{item.title}</h3>
            <p className="text-sm text-[#4A6280]">{item.desc}</p>
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}
