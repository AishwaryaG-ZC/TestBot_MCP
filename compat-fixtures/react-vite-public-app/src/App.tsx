import React, { useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';

const accounts = [
  { name: 'Northwind Robotics', risk: 'High Risk', owner: 'Maya Chen' },
  { name: 'Acme Analytics', risk: 'Healthy', owner: 'Jordan Lee' },
  { name: 'Globex Logistics', risk: 'Medium Risk', owner: 'Priya Nair' }
];

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <h1>Customer Success Console</h1>
      <nav aria-label="Primary navigation">
        <Link to="/">Overview</Link>
        <Link to="/accounts">Accounts</Link>
        <Link to="/plan">Success Plan</Link>
      </nav>
      {children}
    </main>
  );
}

export function Overview() {
  return (
    <Shell>
      <section aria-label="Renewal Risk Queue">
        <h2>Renewal Risk Queue</h2>
        <p>Northwind Robotics requires executive sponsor follow-up.</p>
        <p>Expansion Pipeline: 1.2M dollars</p>
        <button type="button">Review Queue</button>
      </section>
    </Shell>
  );
}

export function Accounts() {
  const [filter, setFilter] = useState('All');
  const visible = filter === 'All' ? accounts : accounts.filter((account) => account.risk === filter);
  return (
    <Shell>
      <h2>At Risk Accounts</h2>
      <label htmlFor="risk-filter">Risk Filter</label>
      <select id="risk-filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option>All</option>
        <option>High Risk</option>
        <option>Medium Risk</option>
        <option>Healthy</option>
      </select>
      <ul>
        {visible.map((account) => (
          <li key={account.name}>
            <strong>{account.name}</strong> <span>{account.risk}</span> <span>{account.owner}</span>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

export function Plan() {
  const [submitted, setSubmitted] = useState(false);
  return (
    <Shell>
      <h2>Success Plan</h2>
      <form aria-label="Success plan form" noValidate onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}>
        <label htmlFor="account-name">Account Name</label>
        <input
          id="account-name"
          name="accountName"
          placeholder="Northwind Robotics"
          required
          aria-invalid={submitted ? 'true' : undefined}
        />
        <label htmlFor="renewal-owner">Renewal Owner</label>
        <input
          id="renewal-owner"
          name="renewalOwner"
          placeholder="Maya Chen"
          required
          aria-invalid={submitted ? 'true' : undefined}
        />
        <button type="submit">Save Plan</button>
      </form>
      {submitted ? <p role="alert">Account Name and Renewal Owner are required.</p> : null}
      <p role="status">Plan Saved</p>
    </Shell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/accounts" element={<Accounts />} />
      <Route path="/plan" element={<Plan />} />
    </Routes>
  );
}
