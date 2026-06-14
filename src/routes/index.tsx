import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: App })

function App() {
  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />
        <p className="island-kicker mb-3">Tesla Model Y · Fleet API</p>
        <h1 className="display-title mb-5 max-w-3xl text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
          Your charging and drives, finally in one place.
        </h1>
        <p className="mb-8 max-w-2xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
          tesboard gently polls your Tesla via the official Fleet API to
          track charging cost, range added, and a record of every drive — read-only,
          and it never wakes your car.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/dashboard"
            className="rounded-full bg-[var(--lagoon-deep)] px-5 py-2.5 text-sm font-semibold text-white no-underline transition hover:-translate-y-0.5"
          >
            Open Dashboard
          </Link>
          <Link
            to="/login"
            className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] no-underline transition hover:-translate-y-0.5 hover:border-[rgba(23,58,64,0.35)]"
          >
            Sign in
          </Link>
        </div>
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            'Charging history',
            'Every session with energy added, range gained, and cost.',
          ],
          [
            'Per-charge stats',
            'Money spent and how far each charge can drive.',
          ],
          [
            'Drive records',
            'Trips reconstructed from gentle polling — Tesla has no trip API.',
          ],
          [
            'Read-only & safe',
            'No vehicle commands; reads never wake the car.',
          ],
        ].map(([title, desc], index) => (
          <article
            key={title}
            className="island-shell feature-card rise-in rounded-2xl p-5"
            style={{ animationDelay: `${index * 90 + 80}ms` }}
          >
            <h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">
              {title}
            </h2>
            <p className="m-0 text-sm text-[var(--sea-ink-soft)]">{desc}</p>
          </article>
        ))}
      </section>

      <section className="island-shell mt-8 rounded-2xl p-6">
        <p className="island-kicker mb-2">Getting started</p>
        <ul className="m-0 list-disc space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            Fill in <code>.env</code> (see <code>.env.example</code>) and apply the
            Supabase migration in <code>supabase/migrations</code>.
          </li>
          <li>
            Sign in, then <strong>Link Tesla account</strong> on the dashboard to
            complete OAuth.
          </li>
          <li>
            Point a scheduler at <code>POST /api/cron/poll</code> so snapshots,
            drives, and charges start accruing. Full setup:{' '}
            <code>docs/design/tesla-dashboard.md</code>.
          </li>
        </ul>
      </section>
    </main>
  )
}
