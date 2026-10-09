using './main.bicep'

// What customers use: three zones, a standby database, backups kept for thirty-five days and copied to
// the paired region.

param environment = 'prod'
param alertEmail = 'ops@example.com'
param adminGroupObjectId = '00000000-0000-0000-0000-000000000000'
param publicUrl = 'https://app.blackark.uk'
param monthlyBudget = 1500
// The offices and the VPN staff administer from. Leave empty only while setting up.
param authorizedIpRanges = []

param postgresAdministratorPassword = readEnvironmentVariable('ARK_POSTGRES_ADMIN_PASSWORD', '')
