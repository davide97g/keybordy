# Included in every location: nginx drops the server's add_header lines in any location that sets one
# of its own. style-src keeps 'unsafe-inline' for the style="" attributes the page sets (stagger
# delays, key positions); scripts are 'self' only.
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" always;
