curl -X POST http://localhost:8080/api/invite \
    -H "Content-Type: application/json" \
    -d '{
      "email": "partner@crypto-hedge.com",
      "referrerWallet": "3d9sYxM6cSmL9bZ...1111",
      "referralCode": "ALPHA_GROWTH"
    }'