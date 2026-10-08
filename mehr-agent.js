// Mehr Edge Minimal Test & Stable Node
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        
        if (url.pathname === "/api/status") {
            const auth = request.headers.get("Authorization");
            if (auth !== `Bearer ${env.API_KEY}`) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
            }
            return new Response(JSON.stringify({ status: "online", node: env.NODE_ID || "edge-3" }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        return new Response(JSON.stringify({
            status: "active",
            node_id: env.NODE_ID || "node-edge-3",
            message: "Node is up and running"
        }, null, 2), {
            headers: { "Content-Type": "application/json" }
        });
    }
};
