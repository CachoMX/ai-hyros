export async function build(ctx) { return { checkedAt: ctx.now.toISOString(), engine: 'snapshot-rules' }; }
