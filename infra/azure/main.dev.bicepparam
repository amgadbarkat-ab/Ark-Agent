using './main.bicep'

// A small, cheap copy for trying a release before it reaches customers. Not highly available, and its
// backups stay in one region.

param environment = 'dev'
param alertEmail = 'ops@example.com'
param adminGroupObjectId = '00000000-0000-0000-0000-000000000000'
param publicUrl = 'https://ark-dev.example.com'
param monthlyBudget = 300

// Supplied on the command line from the vault, never written here:
//   -p postgresAdministratorPassword="$(az keyvault secret show ... --query value -o tsv)"
param postgresAdministratorPassword = readEnvironmentVariable('ARK_POSTGRES_ADMIN_PASSWORD', '')
