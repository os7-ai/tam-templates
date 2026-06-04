exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: process.env.SUPABASE_URL,
      key: process.env.SUPABASE_KEY,
    }),
  };
};
