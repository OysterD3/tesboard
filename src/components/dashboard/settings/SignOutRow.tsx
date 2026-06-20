import { useRouter } from '@tanstack/react-router'
import { getSupabaseBrowser } from '../../../lib/supabase-browser'

export function SignOutRow() {
  const router = useRouter()
  async function signOut() {
    await getSupabaseBrowser().auth.signOut()
    await router.navigate({ to: '/login' })
  }
  return (
    <button
      onClick={signOut}
      className="self-center text-[13px] font-semibold text-muted-foreground bg-transparent border border-border rounded-full px-[18px] py-[9px] cursor-pointer"
    >
      Sign out
    </button>
  )
}
