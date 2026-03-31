import Navbar from '@/components/marketing/Navbar';
import Hero from '@/components/marketing/Hero';
import StatsBanner from '@/components/marketing/StatsBanner';
import HowItWorks from '@/components/marketing/HowItWorks';
import Features from '@/components/marketing/Features';
import Integrations from '@/components/marketing/Integrations';
import DashboardPreview from '@/components/marketing/DashboardPreview';
import Pricing from '@/components/marketing/Pricing';
import Footer from '@/components/marketing/Footer';

export const metadata = {
  title: 'TestBot MCP — AI-Powered Testing Agent',
  description: 'TestBot MCP is an AI-native testing agent that auto-generates, runs, and analyzes tests from a single natural language command in your IDE.',
};

export default function MarketingPage() {
  return (
    <div className="min-h-screen bg-black text-white" style={{ scrollBehavior: 'smooth' }}>
      <Navbar />
      <main>
        <Hero />
        <StatsBanner />
        <HowItWorks />
        <Features />
        <Integrations />
        <DashboardPreview />
        <Pricing />

        {/* Get Started CTA section */}
        <section className="py-24 relative pixel-grid" id="get-started">
          <div className="glow-orb w-96 h-96 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          <div className="relative max-w-4xl mx-auto px-6">
            <div className="brutal-card p-12 text-center relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-white" />

              <h2
                className="text-4xl lg:text-5xl font-black text-white mb-4 glitch"
                data-text="Ready to eliminate manual testing?"
              >
                Ready to eliminate manual testing?
              </h2>
              <p className="text-[#a0a0a0] text-lg mb-10 font-mono">
                Set up TestBot MCP in under 5 minutes. No credit card required.
              </p>

              <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-10">
                {[
                  { step: '01', label: 'Install via npm', code: 'npm install -g testbot-mcp' },
                  { step: '02', label: 'Add to IDE config', code: 'testbot-mcp init' },
                  { step: '03', label: 'Say the magic words', code: '"Test my app using testbot mcp"' },
                ].map(({ step, label, code }) => (
                  <div key={step} className="glass-card px-5 py-3 text-sm flex items-start gap-3 text-left">
                    <span className="font-mono font-bold text-white text-xs border border-white px-1.5 py-0.5 flex-shrink-0">{step}</span>
                    <div>
                      <div className="text-white font-bold text-xs uppercase tracking-wider mb-1">{label}</div>
                      <code className="text-[#a0a0a0] text-xs font-mono">{code}</code>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-4 justify-center">
                <a
                  href="#"
                  className="flex items-center gap-2 text-white font-bold px-8 py-3.5 border-2 border-white hover:bg-white hover:text-black transition-all uppercase tracking-widest text-sm font-mono"
                >
                  Read the Docs
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
