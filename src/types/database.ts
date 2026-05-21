export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string | null
          email: string
          name: string
          role: string
        }
        Insert: {
          created_at?: string | null
          email: string
          name: string
          role?: string
        }
        Update: {
          created_at?: string | null
          email?: string
          name?: string
          role?: string
        }
        Relationships: []
      }
      chatbot_instructions: {
        Row: {
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string
          instruction: string
          is_active: boolean | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          instruction: string
          is_active?: boolean | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          instruction?: string
          is_active?: boolean | null
          updated_at?: string | null
        }
        Relationships: []
      }
      conversations: {
        Row: {
          content: string
          created_at: string | null
          customer_id: string | null
          id: string
          input_tokens: number | null
          intent: string | null
          message_id: string | null
          message_type: string | null
          model_used: string | null
          output_tokens: number | null
          role: string
        }
        Insert: {
          content: string
          created_at?: string | null
          customer_id?: string | null
          id?: string
          input_tokens?: number | null
          intent?: string | null
          message_id?: string | null
          message_type?: string | null
          model_used?: string | null
          output_tokens?: number | null
          role: string
        }
        Update: {
          content?: string
          created_at?: string | null
          customer_id?: string | null
          id?: string
          input_tokens?: number | null
          intent?: string | null
          message_id?: string | null
          message_type?: string | null
          model_used?: string | null
          output_tokens?: number | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_flags: {
        Row: {
          created_at: string | null
          customer_id: string
          escalated_to_human: boolean | null
          escalation_reason: string | null
          is_blacklisted: boolean | null
          is_suspicious: boolean | null
          needs_human_review: boolean | null
          vip_status: boolean | null
        }
        Insert: {
          created_at?: string | null
          customer_id: string
          escalated_to_human?: boolean | null
          escalation_reason?: string | null
          is_blacklisted?: boolean | null
          is_suspicious?: boolean | null
          needs_human_review?: boolean | null
          vip_status?: boolean | null
        }
        Update: {
          created_at?: string | null
          customer_id?: string
          escalated_to_human?: boolean | null
          escalation_reason?: string | null
          is_blacklisted?: boolean | null
          is_suspicious?: boolean | null
          needs_human_review?: boolean | null
          vip_status?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_flags_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_rate_limits: {
        Row: {
          customer_id: string
          daily_message_count: number | null
          daily_token_count: number | null
          last_message_at: string | null
          last_reset_at: string | null
          minute_message_count: number | null
        }
        Insert: {
          customer_id: string
          daily_message_count?: number | null
          daily_token_count?: number | null
          last_message_at?: string | null
          last_reset_at?: string | null
          minute_message_count?: number | null
        }
        Update: {
          customer_id?: string
          daily_message_count?: number | null
          daily_token_count?: number | null
          last_message_at?: string | null
          last_reset_at?: string | null
          minute_message_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_rate_limits_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_state: {
        Row: {
          customer_id: string
          reactivation_count: number | null
          reactivation_sent_at: string | null
          state: string
          updated_at: string | null
        }
        Insert: {
          customer_id: string
          reactivation_count?: number | null
          reactivation_sent_at?: string | null
          state?: string
          updated_at?: string | null
        }
        Update: {
          customer_id?: string
          reactivation_count?: number | null
          reactivation_sent_at?: string | null
          state?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_state_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          area: string | null
          created_at: string | null
          custom_schedule: Json | null
          delivery_phone: string | null
          id: string
          meal_time_preference: string | null
          name: string | null
          phone_number: string
          subcontractor_id: string | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          area?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          delivery_phone?: string | null
          id?: string
          meal_time_preference?: string | null
          name?: string | null
          phone_number: string
          subcontractor_id?: string | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          area?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          delivery_phone?: string | null
          id?: string
          meal_time_preference?: string | null
          name?: string | null
          phone_number?: string
          subcontractor_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_subcontractor_id_fkey"
            columns: ["subcontractor_id"]
            isOneToOne: false
            referencedRelation: "subcontractors"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_deliveries: {
        Row: {
          created_at: string | null
          customer_id: string | null
          delivery_date: string
          delivery_proof_id: string | null
          feedback_message: string | null
          feedback_sentiment: string | null
          id: string
          meal_type: string
          notes: string | null
          order_id: string | null
          portions: number
          status: string | null
          subcontractor_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          customer_id?: string | null
          delivery_date: string
          delivery_proof_id?: string | null
          feedback_message?: string | null
          feedback_sentiment?: string | null
          id?: string
          meal_type: string
          notes?: string | null
          order_id?: string | null
          portions: number
          status?: string | null
          subcontractor_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          customer_id?: string | null
          delivery_date?: string
          delivery_proof_id?: string | null
          feedback_message?: string | null
          feedback_sentiment?: string | null
          id?: string
          meal_type?: string
          notes?: string | null
          order_id?: string | null
          portions?: number
          status?: string | null
          subcontractor_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_deliveries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_deliveries_delivery_proof_id_fkey"
            columns: ["delivery_proof_id"]
            isOneToOne: false
            referencedRelation: "delivery_proofs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_deliveries_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_deliveries_subcontractor_id_fkey"
            columns: ["subcontractor_id"]
            isOneToOne: false
            referencedRelation: "subcontractors"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_proofs: {
        Row: {
          caption: string | null
          id: string
          image_url: string | null
          match_confidence: number | null
          match_method: string | null
          matched_customer_id: string | null
          matched_delivery_id: string | null
          received_at: string | null
          sender_phone: string | null
          sent_by: string | null
          sent_to_customer_at: string | null
          status: string | null
          subcontractor_id: string | null
          whatsapp_message_id: string | null
        }
        Insert: {
          caption?: string | null
          id?: string
          image_url?: string | null
          match_confidence?: number | null
          match_method?: string | null
          matched_customer_id?: string | null
          matched_delivery_id?: string | null
          received_at?: string | null
          sender_phone?: string | null
          sent_by?: string | null
          sent_to_customer_at?: string | null
          status?: string | null
          subcontractor_id?: string | null
          whatsapp_message_id?: string | null
        }
        Update: {
          caption?: string | null
          id?: string
          image_url?: string | null
          match_confidence?: number | null
          match_method?: string | null
          matched_customer_id?: string | null
          matched_delivery_id?: string | null
          received_at?: string | null
          sender_phone?: string | null
          sent_by?: string | null
          sent_to_customer_at?: string | null
          status?: string | null
          subcontractor_id?: string | null
          whatsapp_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "delivery_proofs_matched_customer_id_fkey"
            columns: ["matched_customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_proofs_subcontractor_id_fkey"
            columns: ["subcontractor_id"]
            isOneToOne: false
            referencedRelation: "subcontractors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_delivery_proofs_matched_delivery"
            columns: ["matched_delivery_id"]
            isOneToOne: false
            referencedRelation: "daily_deliveries"
            referencedColumns: ["id"]
          },
        ]
      }
      edit_log: {
        Row: {
          action: string
          changed_by: string
          changes: Json
          created_at: string | null
          entity_id: string
          entity_type: string
          id: string
        }
        Insert: {
          action: string
          changed_by: string
          changes: Json
          created_at?: string | null
          entity_id: string
          entity_type: string
          id?: string
        }
        Update: {
          action?: string
          changed_by?: string
          changes?: Json
          created_at?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
        }
        Relationships: []
      }
      message_templates: {
        Row: {
          description: string | null
          key: string
          template: string
          updated_at: string | null
        }
        Insert: {
          description?: string | null
          key: string
          template: string
          updated_at?: string | null
        }
        Update: {
          description?: string | null
          key?: string
          template?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      orders: {
        Row: {
          abandoned_recovery_sent_at: string | null
          area: string
          cancellation_reason: string | null
          cancelled_at: string | null
          completed_at: string | null
          confirmed_at: string | null
          created_at: string | null
          custom_schedule: Json | null
          customer_id: string | null
          delivery_address: string
          followup_sent_at: string | null
          id: string
          meal_time_preference: string
          package_size: number
          paid_at: string | null
          pause_until: string | null
          portions_dinner: number | null
          portions_lunch: number | null
          portions_per_delivery: number
          portions_remaining: number
          price_per_portion: number
          reminder_sent_at: string | null
          start_date: string
          status: string
          total_price: number
          updated_at: string | null
        }
        Insert: {
          abandoned_recovery_sent_at?: string | null
          area: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          customer_id?: string | null
          delivery_address: string
          followup_sent_at?: string | null
          id?: string
          meal_time_preference: string
          package_size: number
          paid_at?: string | null
          pause_until?: string | null
          portions_dinner?: number | null
          portions_lunch?: number | null
          portions_per_delivery: number
          portions_remaining: number
          price_per_portion: number
          reminder_sent_at?: string | null
          start_date: string
          status?: string
          total_price: number
          updated_at?: string | null
        }
        Update: {
          abandoned_recovery_sent_at?: string | null
          area?: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          customer_id?: string | null
          delivery_address?: string
          followup_sent_at?: string | null
          id?: string
          meal_time_preference?: string
          package_size?: number
          paid_at?: string | null
          pause_until?: string | null
          portions_dinner?: number | null
          portions_lunch?: number | null
          portions_per_delivery?: number
          portions_remaining?: number
          price_per_portion?: number
          reminder_sent_at?: string | null
          start_date?: string
          status?: string
          total_price?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_tiers: {
        Row: {
          portions: number
          price_per_portion: number
          updated_at: string | null
        }
        Insert: {
          portions: number
          price_per_portion: number
          updated_at?: string | null
        }
        Update: {
          portions?: number
          price_per_portion?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      processed_messages: {
        Row: {
          error: string | null
          message_id: string
          processed_at: string | null
          received_at: string | null
        }
        Insert: {
          error?: string | null
          message_id: string
          processed_at?: string | null
          received_at?: string | null
        }
        Update: {
          error?: string | null
          message_id?: string
          processed_at?: string | null
          received_at?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string | null
          endpoint: string
          id: string
          last_used_at: string | null
          p256dh: string
          user_email: string
        }
        Insert: {
          auth: string
          created_at?: string | null
          endpoint: string
          id?: string
          last_used_at?: string | null
          p256dh: string
          user_email: string
        }
        Update: {
          auth?: string
          created_at?: string | null
          endpoint?: string
          id?: string
          last_used_at?: string | null
          p256dh?: string
          user_email?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string | null
          updated_by: string | null
          value: string
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value: string
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: string
        }
        Relationships: []
      }
      subcontractor_off_days: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          off_date: string
          reason: string | null
          subcontractor_id: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          off_date: string
          reason?: string | null
          subcontractor_id?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          off_date?: string
          reason?: string | null
          subcontractor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subcontractor_off_days_subcontractor_id_fkey"
            columns: ["subcontractor_id"]
            isOneToOne: false
            referencedRelation: "subcontractors"
            referencedColumns: ["id"]
          },
        ]
      }
      subcontractors: {
        Row: {
          admin_phone: string | null
          admin_phone_2: string | null
          created_at: string | null
          delivery_areas: Json | null
          id: string
          is_active: boolean | null
          late_delivery_count: number | null
          name: string
          notes: string | null
          total_delivery_count: number | null
          updated_at: string | null
        }
        Insert: {
          admin_phone?: string | null
          admin_phone_2?: string | null
          created_at?: string | null
          delivery_areas?: Json | null
          id?: string
          is_active?: boolean | null
          late_delivery_count?: number | null
          name: string
          notes?: string | null
          total_delivery_count?: number | null
          updated_at?: string | null
        }
        Update: {
          admin_phone?: string | null
          admin_phone_2?: string | null
          created_at?: string | null
          delivery_areas?: Json | null
          id?: string
          is_active?: boolean | null
          late_delivery_count?: number | null
          name?: string
          notes?: string | null
          total_delivery_count?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
