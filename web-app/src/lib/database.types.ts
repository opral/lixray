export type Json =
	| string
	| number
	| boolean
	| null
	| { [key: string]: Json | undefined }
	| Json[];

export type Database = {
	graphql_public: {
		Tables: {
			[_ in never]: never;
		};
		Views: {
			[_ in never]: never;
		};
		Functions: {
			graphql: {
				Args: {
					extensions?: Json;
					operationName?: string;
					query?: string;
					variables?: Json;
				};
				Returns: Json;
			};
		};
		Enums: {
			[_ in never]: never;
		};
		CompositeTypes: {
			[_ in never]: never;
		};
	};
	public: {
		Tables: {
			handles: {
				Row: {
					created_at: string;
					handle: string;
					namespace_id: string | null;
					reason: string | null;
					squat_key: string | null;
					state: string;
				};
				Insert: {
					created_at?: string;
					handle: string;
					namespace_id?: string | null;
					reason?: string | null;
					squat_key?: string | null;
					state?: string;
				};
				Update: {
					created_at?: string;
					handle?: string;
					namespace_id?: string | null;
					reason?: string | null;
					squat_key?: string | null;
					state?: string;
				};
				Relationships: [
					{
						foreignKeyName: "handles_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: true;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			mcp_lix_connections: {
				Row: {
					connected_at: string;
					last_seen_at: string;
					last_tool: string;
					lix_id: string;
					oauth_client_id: string;
					user_id: string;
				};
				Insert: {
					connected_at?: string;
					last_seen_at?: string;
					last_tool: string;
					lix_id: string;
					oauth_client_id: string;
					user_id: string;
				};
				Update: {
					connected_at?: string;
					last_seen_at?: string;
					last_tool?: string;
					lix_id?: string;
					oauth_client_id?: string;
					user_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: "mcp_lix_connections_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: false;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
				];
			};
			lix_members: {
				Row: {
					created_at: string;
					lix_id: string;
					role: Database["public"]["Enums"]["lix_role"];
					user_id: string;
				};
				Insert: {
					created_at?: string;
					lix_id: string;
					role?: Database["public"]["Enums"]["lix_role"];
					user_id: string;
				};
				Update: {
					created_at?: string;
					lix_id?: string;
					role?: Database["public"]["Enums"]["lix_role"];
					user_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: "lix_members_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: false;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
				];
			};
			lix_invite_links: {
				Row: {
					created_at: string;
					created_by: string | null;
					lix_id: string;
					token: string;
				};
				Insert: {
					created_at?: string;
					created_by?: string | null;
					lix_id: string;
					token: string;
				};
				Update: {
					created_at?: string;
					created_by?: string | null;
					lix_id?: string;
					token?: string;
				};
				Relationships: [
					{
						foreignKeyName: "lix_invite_links_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: true;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
				];
			};
			lix_publications: {
				Row: {
					created_at: string;
					kind: Database["public"]["Enums"]["lix_publication_kind"];
					lix_id: string;
					path: string;
					published_by: string;
				};
				Insert: {
					created_at?: string;
					kind: Database["public"]["Enums"]["lix_publication_kind"];
					lix_id: string;
					path: string;
					published_by: string;
				};
				Update: {
					created_at?: string;
					kind?: Database["public"]["Enums"]["lix_publication_kind"];
					lix_id?: string;
					path?: string;
					published_by?: string;
				};
				Relationships: [
					{
						foreignKeyName: "lix_publications_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: false;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
				];
			};
			lix_share_tokens: {
				Row: {
					can_edit: boolean;
					created_at: string;
					id: string;
					lix_id: string;
					revoked_at: string | null;
					shared_by: string;
					token_hash: string;
				};
				Insert: {
					can_edit?: boolean;
					created_at?: string;
					id?: string;
					lix_id: string;
					revoked_at?: string | null;
					shared_by: string;
					token_hash: string;
				};
				Update: {
					can_edit?: boolean;
					created_at?: string;
					id?: string;
					lix_id?: string;
					revoked_at?: string | null;
					shared_by?: string;
					token_hash?: string;
				};
				Relationships: [
					{
						foreignKeyName: "lix_share_tokens_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: false;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
				];
			};
			lixes: {
				Row: {
					created_at: string;
					deleted_at: string | null;
					id: string;
					name: string;
					namespace_id: string;
					slug: string;
					slug_squat_key: string | null;
					updated_at: string;
					visibility: Database["public"]["Enums"]["lix_visibility"];
				};
				Insert: {
					created_at?: string;
					deleted_at?: string | null;
					id?: string;
					name: string;
					namespace_id: string;
					slug: string;
					slug_squat_key?: string | null;
					updated_at?: string;
					visibility?: Database["public"]["Enums"]["lix_visibility"];
				};
				Update: {
					created_at?: string;
					deleted_at?: string | null;
					id?: string;
					name?: string;
					namespace_id?: string;
					slug?: string;
					slug_squat_key?: string | null;
					updated_at?: string;
					visibility?: Database["public"]["Enums"]["lix_visibility"];
				};
				Relationships: [
					{
						foreignKeyName: "lixes_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: false;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			namespace_invite_links: {
				Row: {
					created_at: string;
					created_by: string | null;
					namespace_id: string;
					token: string;
				};
				Insert: {
					created_at?: string;
					created_by?: string | null;
					namespace_id: string;
					token: string;
				};
				Update: {
					created_at?: string;
					created_by?: string | null;
					namespace_id?: string;
					token?: string;
				};
				Relationships: [
					{
						foreignKeyName: "namespace_invite_links_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: true;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			namespace_members: {
				Row: {
					created_at: string;
					namespace_id: string;
					role: Database["public"]["Enums"]["namespace_role"];
					user_id: string;
				};
				Insert: {
					created_at?: string;
					namespace_id: string;
					role?: Database["public"]["Enums"]["namespace_role"];
					user_id: string;
				};
				Update: {
					created_at?: string;
					namespace_id?: string;
					role?: Database["public"]["Enums"]["namespace_role"];
					user_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: "namespace_members_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: false;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			namespaces: {
				Row: {
					created_at: string;
					id: string;
					name: string;
					updated_at: string;
				};
				Insert: {
					created_at?: string;
					id?: string;
					name: string;
					updated_at?: string;
				};
				Update: {
					created_at?: string;
					id?: string;
					name?: string;
					updated_at?: string;
				};
				Relationships: [];
			};
			namespace_profiles: {
				Row: {
					created_at: string;
					document: Json;
					namespace_id: string;
					updated_at: string;
				};
				Insert: {
					created_at?: string;
					document: Json;
					namespace_id: string;
					updated_at?: string;
				};
				Update: {
					created_at?: string;
					document?: Json;
					namespace_id?: string;
					updated_at?: string;
				};
				Relationships: [
					{
						foreignKeyName: "namespace_profiles_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: true;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			profiles: {
				Row: {
					created_at: string;
					email: string;
					id: string;
					name: string;
					updated_at: string;
				};
				Insert: {
					created_at?: string;
					email: string;
					id: string;
					name: string;
					updated_at?: string;
				};
				Update: {
					created_at?: string;
					email?: string;
					id?: string;
					name?: string;
					updated_at?: string;
				};
				Relationships: [];
			};
			user_primary_namespaces: {
				Row: {
					created_at: string;
					namespace_id: string;
					user_id: string;
				};
				Insert: {
					created_at?: string;
					namespace_id: string;
					user_id: string;
				};
				Update: {
					created_at?: string;
					namespace_id?: string;
					user_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: "user_primary_namespaces_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: true;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
		};
		Views: {
			[_ in never]: never;
		};
		Functions: {
			accept_lix_share_token: { Args: { p_token: string }; Returns: string };
			accept_namespace_invite: {
				Args: { p_token: string };
				Returns: {
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
				}[];
			};
			bootstrap_personal_namespace: {
				Args: never;
				Returns: {
					created: boolean;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
				}[];
			};
			create_lix_share_token: {
				Args: { p_lix_id: string };
				Returns: {
					token: string;
				}[];
			};
			create_namespace: { Args: { p_name: string }; Returns: string };
			delete_lix: { Args: { p_lix_id: string }; Returns: undefined };
			get_namespace_invite_link: {
				Args: { p_namespace_id: string };
				Returns: string;
			};
			get_lix_invite_link: {
				Args: { p_lix_id: string };
				Returns: string;
			};
			list_accessible_lixes: {
				Args: never;
				Returns: {
					lix_created_at: string;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					lix_updated_at: string;
					lix_role: Database["public"]["Enums"]["lix_role"];
					lix_visibility: Database["public"]["Enums"]["lix_visibility"];
					namespace_created_at: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_is_personal: boolean;
					namespace_name: string;
					namespace_role: Database["public"]["Enums"]["namespace_role"];
					namespace_updated_at: string;
				}[];
			};
			list_public_profile_lixes: {
				Args: { p_namespace_id: string };
				Returns: {
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					lix_updated_at: string;
					namespace_handle: string;
					namespace_id: string;
				}[];
			};
			list_lix_members: {
				Args: { p_lix_id: string };
				Returns: {
					avatar_url: string | null;
					email: string;
					joined_at: string;
					name: string;
					role: Database["public"]["Enums"]["lix_role"];
					user_id: string;
				}[];
			};
			list_lix_publications: {
				Args: { p_lix_id: string };
				Returns: {
					created_at: string;
					kind: Database["public"]["Enums"]["lix_publication_kind"];
					path: string;
					published_by: string;
				}[];
			};
			publish_lix_resource: {
				Args: {
					p_kind: Database["public"]["Enums"]["lix_publication_kind"];
					p_lix_id: string;
					p_path: string;
				};
				Returns: undefined;
			};
			list_namespace_members: {
				Args: { p_namespace_id: string };
				Returns: {
					avatar_url: string | null;
					email: string;
					joined_at: string;
					name: string;
					role: Database["public"]["Enums"]["namespace_role"];
					user_id: string;
				}[];
			};
			remove_lix_member: {
				Args: { p_lix_id: string; p_user_id: string };
				Returns: undefined;
			};
			remove_namespace_member: {
				Args: { p_namespace_id: string; p_user_id: string };
				Returns: undefined;
			};
			rename_namespace: {
				Args: { p_name: string; p_namespace_id: string };
				Returns: undefined;
			};
			reset_namespace_invite_link: {
				Args: { p_namespace_id: string };
				Returns: string;
			};
			reset_lix_invite_link: {
				Args: { p_lix_id: string };
				Returns: string;
			};
			record_mcp_lix_connection: {
				Args: { p_lix_id: string; p_tool_name: string };
				Returns: undefined;
			};
			resolve_lix_share_token: {
				Args: { p_token: string };
				Returns: {
					can_edit: boolean;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
					path_public: boolean;
					role: Database["public"]["Enums"]["lix_role"] | null;
					shared_by_avatar_url: string;
					shared_by_name: string;
					visibility: Database["public"]["Enums"]["lix_visibility"];
				}[];
			};
			resolve_public_profile_by_handle: {
				Args: { p_handle: string };
				Returns: {
					namespace_created_at: string;
					namespace_handle: string;
					namespace_id: string;
				}[];
			};
			resolve_public_lix: {
				Args: { p_lix_id: string; p_path?: string };
				Returns: {
					can_edit: boolean;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
					path_public: boolean;
					role: Database["public"]["Enums"]["lix_role"] | null;
					visibility: Database["public"]["Enums"]["lix_visibility"];
				}[];
			};
			resolve_public_lix_by_route: {
				Args: {
					p_lix_slug: string;
					p_namespace_handle: string;
					p_path?: string;
				};
				Returns: {
					can_edit: boolean;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
					path_public: boolean;
					role: Database["public"]["Enums"]["lix_role"] | null;
					visibility: Database["public"]["Enums"]["lix_visibility"];
				}[];
			};
			revoke_lix_share_token: { Args: { p_token: string }; Returns: undefined };
			set_lix_member_role: {
				Args: {
					p_lix_id: string;
					p_role: Database["public"]["Enums"]["lix_role"];
					p_user_id: string;
				};
				Returns: undefined;
			};
			set_lix_visibility: {
				Args: {
					p_lix_id: string;
					p_visibility: Database["public"]["Enums"]["lix_visibility"];
				};
				Returns: undefined;
			};
			unpublish_lix_resource: {
				Args: {
					p_kind: Database["public"]["Enums"]["lix_publication_kind"];
					p_lix_id: string;
					p_path: string;
				};
				Returns: undefined;
			};
		};
		Enums: {
			lix_publication_kind: "file" | "directory";
			lix_role: "admin" | "member";
			lix_visibility: "private" | "public";
			namespace_role: "owner" | "member";
		};
		CompositeTypes: {
			[_ in never]: never;
		};
	};
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
	keyof Database,
	"public"
>];

export type Tables<
	DefaultSchemaTableNameOrOptions extends
		| keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
		| { schema: keyof DatabaseWithoutInternals },
	TableName extends DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
				DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
		: never = never,
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
			DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
			Row: infer R;
		}
		? R
		: never
	: DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
				DefaultSchema["Views"])
		? (DefaultSchema["Tables"] &
				DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
				Row: infer R;
			}
			? R
			: never
		: never;

export type TablesInsert<
	DefaultSchemaTableNameOrOptions extends
		| keyof DefaultSchema["Tables"]
		| { schema: keyof DatabaseWithoutInternals },
	TableName extends DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
		: never = never,
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
			Insert: infer I;
		}
		? I
		: never
	: DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
		? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
				Insert: infer I;
			}
			? I
			: never
		: never;

export type TablesUpdate<
	DefaultSchemaTableNameOrOptions extends
		| keyof DefaultSchema["Tables"]
		| { schema: keyof DatabaseWithoutInternals },
	TableName extends DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
		: never = never,
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
			Update: infer U;
		}
		? U
		: never
	: DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
		? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
				Update: infer U;
			}
			? U
			: never
		: never;

export type Enums<
	DefaultSchemaEnumNameOrOptions extends
		| keyof DefaultSchema["Enums"]
		| { schema: keyof DatabaseWithoutInternals },
	EnumName extends DefaultSchemaEnumNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
		: never = never,
> = DefaultSchemaEnumNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
	: DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
		? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
		: never;

export type CompositeTypes<
	PublicCompositeTypeNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	},
	CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
		: never = never,
> = PublicCompositeTypeNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
	: PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
		? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
		: never;

export const Constants = {
	graphql_public: {
		Enums: {},
	},
	public: {
		Enums: {
			namespace_kind: ["personal", "organization"],
			namespace_role: ["owner", "member"],
		},
	},
} as const;
