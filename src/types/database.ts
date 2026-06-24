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
      accounts: {
        Row: {
          category: string
          code: string
          created_at: string | null
          id: string
          is_active: boolean
          name: string
          normal_balance: string
          type: string
        }
        Insert: {
          category: string
          code: string
          created_at?: string | null
          id?: string
          is_active?: boolean
          name: string
          normal_balance: string
          type: string
        }
        Update: {
          category?: string
          code?: string
          created_at?: string | null
          id?: string
          is_active?: boolean
          name?: string
          normal_balance?: string
          type?: string
        }
        Relationships: []
      }
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
      broadcast_recipients: {
        Row: {
          broadcast_id: string
          customer_id: string
          error: string | null
          id: string
          personalized_message: string
          phone_number: string
          sent_at: string | null
          status: string
        }
        Insert: {
          broadcast_id: string
          customer_id: string
          error?: string | null
          id?: string
          personalized_message: string
          phone_number: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          broadcast_id?: string
          customer_id?: string
          error?: string | null
          id?: string
          personalized_message?: string
          phone_number?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "broadcast_recipients_broadcast_id_fkey"
            columns: ["broadcast_id"]
            isOneToOne: false
            referencedRelation: "broadcasts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "broadcast_recipients_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      broadcasts: {
        Row: {
          created_at: string
          created_by: string
          filter: Json
          id: string
          instruction: string
          message_template: string
          recipient_count: number
          status: string
        }
        Insert: {
          created_at?: string
          created_by: string
          filter?: Json
          id?: string
          instruction: string
          message_template: string
          recipient_count?: number
          status?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          filter?: Json
          id?: string
          instruction?: string
          message_template?: string
          recipient_count?: number
          status?: string
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
          media_id: string | null
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
          media_id?: string | null
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
          media_id?: string | null
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
          last_human_activity_at: string | null
          needs_human_review: boolean | null
          pending_bot_question: string | null
          pending_bot_response: boolean
          vip_status: boolean | null
        }
        Insert: {
          created_at?: string | null
          customer_id: string
          escalated_to_human?: boolean | null
          escalation_reason?: string | null
          is_blacklisted?: boolean | null
          is_suspicious?: boolean | null
          last_human_activity_at?: string | null
          needs_human_review?: boolean | null
          pending_bot_question?: string | null
          pending_bot_response?: boolean
          vip_status?: boolean | null
        }
        Update: {
          created_at?: string | null
          customer_id?: string
          escalated_to_human?: boolean | null
          escalation_reason?: string | null
          is_blacklisted?: boolean | null
          is_suspicious?: boolean | null
          last_human_activity_at?: string | null
          needs_human_review?: boolean | null
          pending_bot_question?: string | null
          pending_bot_response?: boolean
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
          menu_shown: boolean
          reactivation_count: number | null
          reactivation_sent_at: string | null
          state: string
          updated_at: string | null
        }
        Insert: {
          customer_id: string
          menu_shown?: boolean
          reactivation_count?: number | null
          reactivation_sent_at?: string | null
          state?: string
          updated_at?: string | null
        }
        Update: {
          customer_id?: string
          menu_shown?: boolean
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
          ad_creative: string | null
          address: string | null
          address_2: string | null
          address_type: string | null
          area: string | null
          area_2: string | null
          avg_price_per_portion: number
          converted_at: string | null
          converted_to_subscription: boolean
          created_at: string | null
          custom_schedule: Json | null
          customer_number: number | null
          delivery_phone: string | null
          delivery_position: number | null
          delivery_route: number | null
          first_message: string | null
          google_maps_link: string | null
          google_maps_link_2: string | null
          id: string
          meal_time_preference: string | null
          name: string | null
          notes: string | null
          package: string | null
          phone_number: string
          portions_remaining: number
          promo_used: string | null
          sub_area: string | null
          sub_area_2: string | null
          subcontractor_id: string | null
          total_payment: number | null
          total_portions: number | null
          updated_at: string | null
        }
        Insert: {
          ad_creative?: string | null
          address?: string | null
          address_2?: string | null
          address_type?: string | null
          area?: string | null
          area_2?: string | null
          avg_price_per_portion?: number
          converted_at?: string | null
          converted_to_subscription?: boolean
          created_at?: string | null
          custom_schedule?: Json | null
          customer_number?: number | null
          delivery_phone?: string | null
          delivery_position?: number | null
          delivery_route?: number | null
          first_message?: string | null
          google_maps_link?: string | null
          google_maps_link_2?: string | null
          id?: string
          meal_time_preference?: string | null
          name?: string | null
          notes?: string | null
          package?: string | null
          phone_number: string
          portions_remaining?: number
          promo_used?: string | null
          sub_area?: string | null
          sub_area_2?: string | null
          subcontractor_id?: string | null
          total_payment?: number | null
          total_portions?: number | null
          updated_at?: string | null
        }
        Update: {
          ad_creative?: string | null
          address?: string | null
          address_2?: string | null
          address_type?: string | null
          area?: string | null
          area_2?: string | null
          avg_price_per_portion?: number
          converted_at?: string | null
          converted_to_subscription?: boolean
          created_at?: string | null
          custom_schedule?: Json | null
          customer_number?: number | null
          delivery_phone?: string | null
          delivery_position?: number | null
          delivery_route?: number | null
          first_message?: string | null
          google_maps_link?: string | null
          google_maps_link_2?: string | null
          id?: string
          meal_time_preference?: string | null
          name?: string | null
          notes?: string | null
          package?: string | null
          phone_number?: string
          portions_remaining?: number
          promo_used?: string | null
          sub_area?: string | null
          sub_area_2?: string | null
          subcontractor_id?: string | null
          total_payment?: number | null
          total_portions?: number | null
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
          address_slot: number
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
          quota_deducted: boolean
          status: string | null
          subcontractor_id: string | null
          updated_at: string | null
        }
        Insert: {
          address_slot?: number
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
          quota_deducted?: boolean
          status?: string | null
          subcontractor_id?: string | null
          updated_at?: string | null
        }
        Update: {
          address_slot?: number
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
          quota_deducted?: boolean
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
      journal_lines: {
        Row: {
          account_id: string
          credit: number
          debit: number
          id: string
          journal_id: string
        }
        Insert: {
          account_id: string
          credit?: number
          debit?: number
          id?: string
          journal_id: string
        }
        Update: {
          account_id?: string
          credit?: number
          debit?: number
          id?: string
          journal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journal_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_lines_journal_id_fkey"
            columns: ["journal_id"]
            isOneToOne: false
            referencedRelation: "journals"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_sequences: {
        Row: {
          last_seq: number
          year: number
        }
        Insert: {
          last_seq?: number
          year: number
        }
        Update: {
          last_seq?: number
          year?: number
        }
        Relationships: []
      }
      journals: {
        Row: {
          created_at: string | null
          date: string
          description: string
          id: string
          reference: string
          source_id: string | null
          source_type: string | null
        }
        Insert: {
          created_at?: string | null
          date: string
          description: string
          id?: string
          reference: string
          source_id?: string | null
          source_type?: string | null
        }
        Update: {
          created_at?: string | null
          date?: string
          description?: string
          id?: string
          reference?: string
          source_id?: string | null
          source_type?: string | null
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
          addon_cost_per_portion: number
          area: string
          cancellation_reason: string | null
          cancelled_at: string | null
          completed_at: string | null
          confirmed_at: string | null
          created_at: string | null
          custom_schedule: Json | null
          customer_id: string | null
          delivery_address: string
          end_date: string | null
          followup_sent_at: string | null
          id: string
          maps_link: string | null
          meal_time_preference: string | null
          order_type: string
          package_size: number
          paid_at: string | null
          pause_until: string | null
          payment_proof_url: string | null
          portions_dinner: number | null
          portions_lunch: number | null
          portions_per_delivery: number
          portions_remaining: number
          price_per_portion: number
          reminder_sent_at: string | null
          size: string
          start_date: string
          status: string
          subcontractor_id: string | null
          total_price: number
          updated_at: string | null
        }
        Insert: {
          abandoned_recovery_sent_at?: string | null
          addon_cost_per_portion?: number
          area: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          customer_id?: string | null
          delivery_address: string
          end_date?: string | null
          followup_sent_at?: string | null
          id?: string
          maps_link?: string | null
          meal_time_preference?: string | null
          order_type?: string
          package_size: number
          paid_at?: string | null
          pause_until?: string | null
          payment_proof_url?: string | null
          portions_dinner?: number | null
          portions_lunch?: number | null
          portions_per_delivery: number
          portions_remaining: number
          price_per_portion: number
          reminder_sent_at?: string | null
          size?: string
          start_date: string
          status?: string
          subcontractor_id?: string | null
          total_price: number
          updated_at?: string | null
        }
        Update: {
          abandoned_recovery_sent_at?: string | null
          addon_cost_per_portion?: number
          area?: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          customer_id?: string | null
          delivery_address?: string
          end_date?: string | null
          followup_sent_at?: string | null
          id?: string
          maps_link?: string | null
          meal_time_preference?: string | null
          order_type?: string
          package_size?: number
          paid_at?: string | null
          pause_until?: string | null
          payment_proof_url?: string | null
          portions_dinner?: number | null
          portions_lunch?: number | null
          portions_per_delivery?: number
          portions_remaining?: number
          price_per_portion?: number
          reminder_sent_at?: string | null
          size?: string
          start_date?: string
          status?: string
          subcontractor_id?: string | null
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
          {
            foreignKeyName: "orders_subcontractor_id_fkey"
            columns: ["subcontractor_id"]
            isOneToOne: false
            referencedRelation: "subcontractors"
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
          cost_per_portion: number
          created_at: string | null
          customer_nickname: string | null
          delivery_areas: Json | null
          id: string
          is_active: boolean | null
          late_delivery_count: number | null
          menu_image_url: string | null
          menu_text: string | null
          name: string
          notes: string | null
          total_delivery_count: number | null
          updated_at: string | null
        }
        Insert: {
          admin_phone?: string | null
          admin_phone_2?: string | null
          cost_per_portion?: number
          created_at?: string | null
          customer_nickname?: string | null
          delivery_areas?: Json | null
          id?: string
          is_active?: boolean | null
          late_delivery_count?: number | null
          menu_image_url?: string | null
          menu_text?: string | null
          name: string
          notes?: string | null
          total_delivery_count?: number | null
          updated_at?: string | null
        }
        Update: {
          admin_phone?: string | null
          admin_phone_2?: string | null
          cost_per_portion?: number
          created_at?: string | null
          customer_nickname?: string | null
          delivery_areas?: Json | null
          id?: string
          is_active?: boolean | null
          late_delivery_count?: number | null
          menu_image_url?: string | null
          menu_text?: string | null
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
      next_journal_reference: { Args: { p_year: number }; Returns: string }
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
