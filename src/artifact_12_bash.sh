curl -s http://localhost:8080/health | jq .
   # Expected: { "status": "UP", "websocket_connected": true, "processed_events": 1420 }