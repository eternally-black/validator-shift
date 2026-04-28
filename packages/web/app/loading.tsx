export default function Loading() {
  return (
    <div className="py-12 space-y-6" aria-busy="true">
      <div className="h-12 w-2/3 bg-zinc-900 rounded animate-pulse" />
      <div className="h-5 w-1/2 bg-zinc-900 rounded animate-pulse" />
      <div className="h-10 w-40 bg-zinc-900 rounded animate-pulse" />
    </div>
  )
}
