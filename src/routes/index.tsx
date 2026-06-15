import { createFileRoute, redirect } from '@tanstack/react-router'

// The dashboard is the home of this app. Visiting the root sends you straight
// there; the dashboard's own `beforeLoad` redirects to /login when not authed.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/dashboard' })
  },
})
