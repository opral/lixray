const session = () => ({
  activeAccountId: async () => '00000000-0000-7000-8000-000000000003',
  openAnotherSession: async () => session(),
  setTelemetryParent() {},
  close: async () => {},
});
export const openLixBinding = async () => session();
export const convertReplicaBinding = async () => {};
export const retryReplicaMigrationCleanupBinding = async () => {};
export const createHostedBinding = async () => {};
export const deleteHostedBinding = async () => {};
