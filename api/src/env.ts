export const config = {
  stage: process.env.STAGE || "local",
  tableName: process.env.TABLE_NAME || "jigs-local",
  templateBucket: process.env.TEMPLATE_BUCKET || "jigs-templates-local",
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID || "",
  cognitoClientId: process.env.COGNITO_CLIENT_ID || "",
  isLocal: (process.env.STAGE || "local") === "local",
};
