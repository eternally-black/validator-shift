export default function Loading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="h-8 w-1/3 bg-zinc-900 rounded animate-pulse" />
      <div className="rounded border border-zinc-800 p-4 space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-6 bg-zinc-900 rounded animate-pulse" />
        ))}
      </div>
    </div>
  )
}
