'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';

const TIERS = [
  {
    name: 'Starter',
    price: '$0',
    period: '/month',
    tagline: 'Perfect for individual developers',
    features: [
      { text: 'Unlimited test runs', included: true },
      { text: 'Auto-detection', included: true },
      { text: 'OpenAI test generation', included: true },
      { text: 'Interactive dashboard', included: true },
      { text: '1 AI provider', included: true },
      { text: 'Jira integration', included: false },
      { text: 'Team analytics', included: false },
    ],
    cta: 'Get Started Free',
    ctaHref: '/home',
    popular: false,
  },
  {
    name: 'Pro',
    price: '$29',
    period: '/month',
    tagline: 'For teams who ship fast',
    features: [
      { text: 'Everything in Starter', included: true },
      { text: 'Jira integration', included: true },
      { text: 'All AI providers', included: true },
      { text: 'Team analytics', included: true },
      { text: 'Priority support', included: true },
      { text: 'CI/CD integration', included: true },
      { text: 'Custom AI prompts', included: true },
    ],
    cta: 'Start Pro Trial',
    ctaHref: '/home',
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    tagline: 'For large engineering teams',
    features: [
      { text: 'Everything in Pro', included: true },
      { text: 'SSO / SAML', included: true },
      { text: 'Self-hosted option', included: true },
      { text: 'Custom AI model', included: true },
      { text: 'SLA guarantee', included: true },
      { text: 'Dedicated support', included: true },
      { text: 'Audit logs', included: true },
    ],
    cta: 'Contact Sales',
    ctaHref: 'mailto:zapminds@zapcg.com',
    popular: false,
  },
];

export default function Pricing() {
  return (
    <section className="py-24 bg-black relative" id="pricing">
      <div className="relative max-w-6xl mx-auto px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <div className="y2k-badge mb-4">Pricing</div>
          <h2 className="text-4xl lg:text-5xl font-black text-white leading-tight mb-4 mt-4">
            Simple, transparent pricing.
          </h2>
          <p className="text-[#a0a0a0] text-base font-mono">Start free. Scale as your team grows.</p>
        </motion.div>

        {/* Pricing cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {TIERS.map((tier, i) => (
            <motion.div
              key={tier.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              whileHover={{ x: -2, y: -2, boxShadow: '6px 6px 0px #ffffff', borderColor: '#ffffff' }}
              className={`relative bg-[#111] p-8 flex flex-col transition-all duration-75 ${
                tier.popular
                  ? 'border-2 border-white shadow-[4px_4px_0px_#ffffff]'
                  : 'border-2 border-[#333] shadow-[4px_4px_0px_#333]'
              }`}
            >
              {/* Popular badge */}
              {tier.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span className="y2k-badge bg-white text-black border-black animate-stamp">★ Most Popular</span>
                </div>
              )}

              {/* Top accent */}
              {tier.popular && <div className="absolute top-0 left-0 right-0 h-0.5 bg-white" />}

              <div className="mb-6">
                <div className="text-[#a0a0a0] text-xs font-black uppercase tracking-widest font-mono mb-3">{tier.name}</div>
                <div className="flex items-end gap-1 mb-1">
                  <span className="text-4xl font-black text-white font-mono">{tier.price}</span>
                  {tier.period && <span className="text-[#a0a0a0] text-sm mb-1 font-mono">{tier.period}</span>}
                </div>
                <p className="text-[#505050] text-xs font-mono">{tier.tagline}</p>
              </div>

              <ul className="flex flex-col gap-3 mb-8 flex-1">
                {tier.features.map((feat) => (
                  <li
                    key={feat.text}
                    className={`flex items-center gap-2.5 text-xs font-mono ${feat.included ? 'text-[#a0a0a0]' : 'text-[#333] line-through'}`}
                  >
                    <span
                      className={`flex-shrink-0 w-4 h-4 border flex items-center justify-center text-xs font-black ${
                        feat.included
                          ? 'border-white text-white'
                          : 'border-[#333] text-[#333]'
                      }`}
                    >
                      {feat.included ? '✓' : '✗'}
                    </span>
                    {feat.text}
                  </li>
                ))}
              </ul>

              <Link
                href={tier.ctaHref}
                className={`w-full py-3 text-xs font-black text-center uppercase tracking-widest font-mono transition-all ${
                  tier.popular
                    ? 'bg-white text-black border-2 border-black hover:bg-black hover:text-white hover:border-white'
                    : 'bg-transparent text-white border-2 border-white hover:bg-white hover:text-black'
                }`}
              >
                {tier.cta}
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
