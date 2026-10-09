import { Agent, install, setGlobalDispatcher } from "undici";

// Keep the Node service on HTTP/1.1 while using the patched parser. Undici 8
// enables HTTP/2 by default; Node 24's bundled fetch still uses HTTP/1.1.
// Installing every Fetch API class together keeps Request/Response brands
// consistent across the Railway adapter and the dynamically imported app.
setGlobalDispatcher(new Agent({ allowH2: false }));
install();
