update artworks
set status = 'minted'
where status <> 'minted'
  and mint->>'status' = 'confirmed'
  and coalesce(mint->>'tokenId', '') <> ''
  and coalesce(mint->>'contractAddress', '') <> ''
  and coalesce(mint->>'transactionHash', '') <> ''
  and coalesce(mint->>'tokenURI', '') <> '';
